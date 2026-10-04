import type { NextConfig } from 'next';

/**
 * Hosts permitted to reach the development server's internal resources
 * (`/_next/*`, which includes the HMR WebSocket endpoint) from a browser origin
 * other than `localhost`.
 *
 * Binding the server with `next dev -H 0.0.0.0` is necessary but not
 * sufficient. Next.js answers `/_next/*` only to `localhost` and `*.localhost`
 * unless a host is listed here; the HMR upgrade is answered with `403
 * Unauthorized`, which Chrome reports as `ERR_INVALID_HTTP_RESPONSE`. The
 * visible symptom is worse than a missing hot reload: the Turbopack dev client
 * never finishes booting, so the page stays frozen on its server-rendered shell
 * — no hydration, no IndexedDB, no workspace.
 *
 * Patterns are dot-separated segments, where `*` matches exactly one segment and
 * `**` (only valid last) matches any remainder. These entries apply to the
 * development server alone: the check is gated behind `opts.dev` in the router
 * server, so `next start` and `next build` are unaffected.
 */
const LOOPBACK_ALIASES = ['127.*.*.*', '::1'];

/**
 * RFC 1918 private ranges. The 172.16.0.0/12 block is enumerated octet by octet
 * because the matcher has no range syntax, and listing only the private half
 * keeps public 172.x space out of the allowlist.
 */
const PRIVATE_LAN_RANGES = [
  '10.*.*.*',
  '192.168.*.*',
  ...Array.from({ length: 16 }, (_, index) => `172.${index + 16}.*.*`),
];

const LAN_DEV_ORIGINS = [
  ...LOOPBACK_ALIASES,
  ...PRIVATE_LAN_RANGES,
  // mDNS names, e.g. http://macbook.local:3000.
  '*.local',
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  allowedDevOrigins: LAN_DEV_ORIGINS,
};

export default nextConfig;