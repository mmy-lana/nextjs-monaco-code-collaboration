import type { SignalingConfig } from '@/types/collaboration';

/**
 * Signaling configuration for an air-gapped LAN.
 *
 * There is no hosted backend, so every peer connects to a locally operated
 * `y-webrtc` signaling server (`pnpm run signaling`, started automatically by
 * `pnpm run dev`). When no signaling server is reachable the provider still works
 * between tabs of the same browser through its BroadcastChannel fallback, and
 * direct WebRTC data channels handle peers once ICE has completed.
 */

/** Port the bundled signaling server listens on. */
export const DEFAULT_SIGNALING_PORT = 4444;

/** Fallback host, used when there is no `window` (server rendering). */
export const LOCAL_SIGNALING_HOSTNAME = 'localhost';

const isSecureOrigin = (): boolean =>
  typeof window !== 'undefined' && window.location.protocol === 'https:';

/**
 * Host the signaling server is reached on.
 *
 * This must be the host the page itself was served from, never a hardcoded
 * `localhost`: a device that loaded the app from `192.168.1.2:3000` would
 * resolve `localhost` to *itself* and find nothing listening, so every peer
 * would sit in the BroadcastChannel fallback believing it was alone. IPv6
 * hostnames arrive already bracketed (`[::1]`), which is the form a URL needs.
 */
export function signalingHostname(): string {
  if (typeof window === 'undefined') return LOCAL_SIGNALING_HOSTNAME;
  return window.location.hostname.length > 0 ? window.location.hostname : LOCAL_SIGNALING_HOSTNAME;
}

/**
 * Mixed-content rules forbid `ws://` from an `https://` origin, so the default
 * scheme follows the page protocol.
 */
export function defaultSignalingUrl(port: number = DEFAULT_SIGNALING_PORT): string {
  return `${isSecureOrigin() ? 'wss' : 'ws'}://${signalingHostname()}:${port}`;
}

/**
 * STUN only — no TURN relay is offered, because relaying traffic through the
 * internet would defeat the offline-first guarantee of this workspace.
 */
export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:global.stun.twilio.com:3478' },
];

/** Read from `.env` when present so a deployment can point at its own server. */
export function readEnvSignalingServers(): string[] | null {
  const configured = process.env.NEXT_PUBLIC_DEFAULT_SIGNALING_SERVER;
  if (!configured) return null;
  const servers = configured
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return servers.length > 0 ? servers : null;
}

/**
 * The signaling list to start from.
 *
 * An explicit environment override wins; otherwise the URL is derived from the
 * host the page was served on. Exposed as a function because the derivation
 * needs `window`, which does not exist while the page is server-rendered: the
 * client re-resolves it after hydration instead of shipping a different initial
 * value to the server render.
 */
export function resolveDefaultSignalingServers(): string[] {
  return readEnvSignalingServers() ?? [defaultSignalingUrl()];
}

export const DEFAULT_SIGNALING: SignalingConfig = {
  servers: resolveDefaultSignalingServers(),
  iceServers: DEFAULT_ICE_SERVERS,
};

const SIGNALING_PATTERN = /^wss?:\/\/[^\s]+$/;

/** Normalises user input into a validated, de-duplicated server list. */
export function parseSignalingServers(raw: string): { servers: string[]; invalid: string[] } {
  const candidates = raw
    .split(/[\n,]/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  const servers: string[] = [];
  const invalid: string[] = [];

  for (const candidate of candidates) {
    if (!SIGNALING_PATTERN.test(candidate)) {
      invalid.push(candidate);
      continue;
    }
    if (!servers.includes(candidate)) servers.push(candidate);
  }

  return { servers, invalid };
}

/** True when the browser can host a `WebSocket` connection at all. */
export function isSignalingSupported(): boolean {
  if (typeof window === 'undefined') return false;
  return typeof window.WebSocket === 'function';
}

/**
 * Promotes a plain host/port to a full URL, so users can type `192.168.1.10`
 * instead of `ws://192.168.1.10:4444`.
 */
export function toSignalingUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (SIGNALING_PATTERN.test(trimmed)) return trimmed;
  if (/^[\w.-]+(:\d+)?$/.test(trimmed)) return `${isSecureOrigin() ? 'wss' : 'ws'}://${trimmed}`;
  return trimmed;
}