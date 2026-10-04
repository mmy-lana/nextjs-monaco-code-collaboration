#!/usr/bin/env node
/**
 * Development runner: the Next.js dev server and a local WebRTC signaling
 * server, started together and torn down together.
 *
 * Running them as two independent commands is how the LAN workflow breaks. The
 * signaling server is easy to forget, and when it is missing `y-webrtc` does not
 * fail loudly — it downgrades to its BroadcastChannel path, which connects only
 * the tabs of a single browser. The room then looks alive on `localhost` while a
 * second device, or the same app on a second loopback address, silently never
 * joins. Starting the rendezvous point here removes that failure mode.
 *
 * Teardown is deliberately in one process: `Ctrl+C` closes the signaling server
 * and terminates Next exactly once, so the signaling port is never left held by
 * a process the user cannot see.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_SIGNALING_HOST,
  DEFAULT_SIGNALING_PORT,
  isPortInUse,
  startSignalingServer,
} from './signaling.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SIGNALING_PORT = Number(process.env.SIGNALING_PORT ?? DEFAULT_SIGNALING_PORT);
const SIGNALING_HOST = process.env.SIGNALING_HOST ?? DEFAULT_SIGNALING_HOST;

/**
 * `next dev` is invoked through the local CLI entry rather than a shell, so
 * there is no quoting to get wrong and the child is a direct process this
 * runner can signal.
 */
const NEXT_BIN = join(ROOT, 'node_modules', 'next', 'dist', 'bin', 'next');

/** Address the dev server binds: every interface, so a LAN peer can load it. */
const DEV_HOST = process.env.DEV_HOST ?? '0.0.0.0';

const log = (message) => console.log(`[dev] ${message}`);

/** Signals that make the runner tear everything down and exit. */
const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM'];

let shuttingDown = false;

async function startSignaling() {
  if (await isPortInUse(SIGNALING_PORT)) {
    log(
      `Signaling port ${SIGNALING_PORT} is already serving; using the existing server instead of starting a second one`,
    );
    return null;
  }

  try {
    const handle = await startSignalingServer({
      port: SIGNALING_PORT,
      host: SIGNALING_HOST,
      log: (message) => log(message),
    });
    return handle;
  } catch (error) {
    if (error?.code === 'EADDRINUSE') {
      log(`Signaling port ${SIGNALING_PORT} was taken while starting; continuing without the bundled server`);
      return null;
    }
    throw error;
  }
}

function startNext() {
  if (!existsSync(NEXT_BIN)) {
    throw new Error(
      `Could not find the Next.js CLI at ${NEXT_BIN}. Run \`pnpm install\` before \`pnpm run dev\`.`,
    );
  }

  const child = spawn(process.execPath, [NEXT_BIN, 'dev', '-H', DEV_HOST], {
    cwd: ROOT,
    stdio: 'inherit',
    /*
     * `NEXT_PUBLIC_DEFAULT_SIGNALING_SERVER` is deliberately left unset. The app
     * derives the signaling URL from `window.location.hostname`, so a peer
     * reached over the LAN talks to this machine instead of to itself; pinning
     * `localhost` here would override exactly that.
     */
    env: process.env,
  });

  child.on('error', (error) => {
    console.error(`[dev] Could not start Next.js: ${error.message}`);
  });

  return child;
}

async function main() {
  const signaling = await startSignaling();
  const next = startNext();

  const shutdown = async (exitCode) => {
    if (shuttingDown) return;
    shuttingDown = true;

    if (next.exitCode === null && next.signalCode === null) {
      next.kill('SIGTERM');
      // A child that ignores SIGTERM must not keep the runner alive.
      const escalation = setTimeout(() => next.kill('SIGKILL'), 5_000);
      escalation.unref();
    }

    if (signaling) await signaling.close();
    process.exit(exitCode);
  };

  for (const signal of SHUTDOWN_SIGNALS) {
    process.on(signal, () => {
      void shutdown(0);
    });
  }

  // The dev server exiting (a crash, or a build error that ended the process)
  // must not leave the signaling server behind.
  next.on('exit', (code, signal) => {
    void shutdown(signal ? 1 : (code ?? 0));
  });
}

main().catch((error) => {
  console.error(`[dev] ${error?.message ?? error}`);
  process.exit(1);
});