#!/usr/bin/env node
/**
 * Local WebRTC signaling server for LAN development.
 *
 * `y-webrtc` needs a rendezvous point: peers exchange SDP offers and ICE
 * candidates through it, but no peer data ever passes through it. Without one
 * reachable, the provider silently falls back to its BroadcastChannel path,
 * which only ever connects tabs of one browser — so a second device on the LAN,
 * or the same app on a second loopback address, can never join a room.
 *
 * This speaks the same wire protocol as `y-webrtc/bin/server.js`
 * (`subscribe` / `unsubscribe` / `publish` / `ping`), but is embedded in the
 * project so that:
 *
 *   - it binds every interface, so a phone or a second machine on the LAN can
 *     reach it (the upstream bin offers no host option and logs a fixed
 *     "localhost" line regardless of where it actually listens);
 *   - it can be started and stopped in-process by `scripts/dev.mjs`, so `Ctrl+C`
 *     tears both servers down together and cannot leave the port held;
 *   - it resolves the real listening port, which is what lets the dev runner
 *     notice that something else already owns the port.
 *
 * Topics map one to one onto rooms. A `publish` is relayed to every other
 * subscriber of that topic, with the current subscriber count attached so a peer
 * can tell whether it was the only one in the room.
 */
import { createServer } from 'node:http';
import net from 'node:net';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';

export const DEFAULT_SIGNALING_PORT = 4444;

/**
 * Every interface, so peers on the LAN can reach the server. Binding to
 * loopback only would make the whole exercise pointless for the second device.
 */
export const DEFAULT_SIGNALING_HOST = '0.0.0.0';

/**
 * Interval between WebSocket-level pings.
 *
 * lib0 closes any socket that has not delivered a message for 30 seconds, so
 * this has to stay well inside that window: it keeps the client's liveness
 * timer satisfied and doubles as dead-connection detection on this side.
 */
const HEARTBEAT_INTERVAL_MS = 15_000;

/** Topics longer than this are rejected; room ids are short by construction. */
const MAX_TOPIC_LENGTH = 256;

/** WebSocket ready states, named to keep the comparisons readable. */
const READY_STATE_CONNECTING = 0;
const READY_STATE_OPEN = 1;

/**
 * @typedef {object} SignalingServerOptions
 * @property {number} [port] Port to listen on; defaults to {@link DEFAULT_SIGNALING_PORT}.
 * @property {string} [host] Interface to bind; defaults to {@link DEFAULT_SIGNALING_HOST}.
 * @property {(message: string) => void} [log] Receives one line per lifecycle event.
 */

/**
 * @typedef {object} SignalingServerHandle
 * @property {string} host Interface the server was bound to.
 * @property {number} port Port the server actually listens on.
 * @property {() => number} connectionCount Number of currently connected clients.
 * @property {() => Promise<void>} close Closes every socket and stops listening.
 */

const isSendable = (socket) =>
  socket.readyState === READY_STATE_OPEN || socket.readyState === READY_STATE_CONNECTING;

/**
 * Starts the signaling server.
 *
 * Resolves once the socket is listening, and rejects with the underlying error
 * (`EADDRINUSE`) so the caller can decide whether to fail or to reuse whatever
 * already owns the port.
 */
export function startSignalingServer({
  port = DEFAULT_SIGNALING_PORT,
  host = DEFAULT_SIGNALING_HOST,
  log = (message) => console.log(message),
} = {}) {
  /** Topic name → sockets subscribed to it. */
  const topics = new Map();

  const wss = new WebSocketServer({ noServer: true });

  /*
   * A plain HTTP surface so the port can be probed with `curl` when diagnosing a
   * device that cannot connect, and so the TCP check below has something to
   * answer on.
   */
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    response.end(
      JSON.stringify({
        service: 'lancodecollab-signaling',
        topics: topics.size,
        connections: wss.clients.size,
      }),
    );
  });

  const send = (socket, message) => {
    if (!isSendable(socket)) {
      socket.terminate();
      return;
    }
    try {
      socket.send(JSON.stringify(message));
    } catch {
      // A peer that vanished mid-send is already gone from `topics`; dropping
      // the frame is the correct outcome.
      socket.terminate();
    }
  };

  const handleConnection = (socket) => {
    /** Topics this socket asked for, so `close` can clean them all up. */
    const subscribed = new Set();
    let alive = true;

    const heartbeat = setInterval(() => {
      if (!alive) {
        socket.terminate();
        return;
      }
      alive = false;
      try {
        socket.ping();
      } catch {
        socket.terminate();
      }
    }, HEARTBEAT_INTERVAL_MS);
    heartbeat.unref?.();

    const forget = (topicName) => {
      const subscribers = topics.get(topicName);
      if (subscribers) {
        subscribers.delete(socket);
        if (subscribers.size === 0) topics.delete(topicName);
      }
      subscribed.delete(topicName);
    };

    socket.on('pong', () => {
      alive = true;
    });

    socket.on('close', () => {
      clearInterval(heartbeat);
      for (const topicName of [...subscribed]) forget(topicName);
    });

    // `close` always follows `error`, and that is where the bookkeeping lives,
    // so an error only needs to stop the socket from lingering.
    socket.on('error', () => socket.terminate());

    socket.on('message', (raw) => {
      let message;
      try {
        message = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
      } catch {
        return;
      }
      if (!message || typeof message.type !== 'string') return;

      switch (message.type) {
        case 'subscribe': {
          const requested = Array.isArray(message.topics) ? message.topics : [];
          for (const topicName of requested) {
            if (typeof topicName !== 'string') continue;
            if (topicName.length === 0 || topicName.length > MAX_TOPIC_LENGTH) continue;
            let subscribers = topics.get(topicName);
            if (!subscribers) {
              subscribers = new Set();
              topics.set(topicName, subscribers);
            }
            subscribers.add(socket);
            subscribed.add(topicName);
          }
          break;
        }
        case 'unsubscribe': {
          const requested = Array.isArray(message.topics) ? message.topics : [];
          for (const topicName of requested) {
            if (typeof topicName === 'string') forget(topicName);
          }
          break;
        }
        case 'publish': {
          if (typeof message.topic !== 'string') return;
          const subscribers = topics.get(message.topic);
          if (!subscribers || subscribers.size === 0) return;
          // The sender is told how many peers share the room, and is not
          // delivered its own announcement back.
          const payload = { ...message, clients: subscribers.size };
          for (const receiver of subscribers) {
            if (receiver !== socket) send(receiver, payload);
          }
          break;
        }
        case 'ping': {
          send(socket, { type: 'pong' });
          break;
        }
        default:
          // Unknown frames are ignored so a newer client cannot break the relay.
          break;
      }
    });
  };

  wss.on('connection', handleConnection);

  server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (websocket) => {
      wss.emit('connection', websocket, request);
    });
  });

  /** Sweeps sockets the peer abandoned without a close frame. */
  const reaper = setInterval(() => {
    for (const client of wss.clients) {
      if (client.readyState === client.CLOSED) client.terminate();
    }
  }, HEARTBEAT_INTERVAL_MS);
  reaper.unref?.();

  return new Promise((resolve, reject) => {
    const onError = (error) => {
      clearInterval(reaper);
      reject(error);
    };

    const onListening = () => {
      const address = server.address();
      const boundPort = typeof address === 'object' && address ? address.port : port;
      log(`Signaling server listening on ws://${host}:${boundPort}`);

      let closing = null;

      resolve({
        host,
        port: boundPort,
        connectionCount: () => wss.clients.size,
        close: () => {
          if (closing) return closing;

          log('Signaling server closing');
          closing = new Promise((resolveClose) => {
            clearInterval(reaper);
            for (const client of wss.clients) client.terminate();
            wss.close(() => {
              server.close(() => resolveClose(undefined));
              /*
               * A half-closed peer would keep the listener alive past `close`.
               * Destroying whatever is left releases the port deterministically,
               * which is what lets `pnpm run dev` start again immediately.
               */
              server.closeAllConnections?.();
            });
          });
          return closing;
        },
      });
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

/**
 * Whether something is already accepting connections on this port.
 *
 * A developer may legitimately be running their own signaling server; in that
 * case the bundled one must not fight for the port.
 */
export function isPortInUse(port, host = '127.0.0.1', timeoutMs = 750) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const settle = (result) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => settle(true));
    socket.once('timeout', () => settle(false));
    socket.once('error', () => settle(false));
    socket.connect(port, host);
  });
}

/** True when this module was executed directly rather than imported. */
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const port = Number(process.env.SIGNALING_PORT ?? DEFAULT_SIGNALING_PORT);
  const host = process.env.SIGNALING_HOST ?? DEFAULT_SIGNALING_HOST;

  startSignalingServer({ port, host })
    .then((handle) => {
      const shutdown = () => {
        handle.close().then(() => process.exit(0));
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    })
    .catch((error) => {
      console.error(`Could not start the signaling server on port ${port}: ${error.message}`);
      process.exit(1);
    });
}