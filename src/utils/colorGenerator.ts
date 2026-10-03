import type { LocalPeerIdentity } from '@/types/collaboration';

/**
 * Deterministic peer identity + cursor colouring.
 *
 * Colours must be stable across reloads and identical for every peer in the
 * room, so all assignment is derived from a stable seed (Yjs `clientID`, or the
 * peer name) rather than from `Math.random()`.
 */

const PEER_COLORS = [
  '#f87171', // Red
  '#fb923c', // Orange
  '#fbbf24', // Amber
  '#4ade80', // Green
  '#34d399', // Emerald
  '#22d3ee', // Cyan
  '#60a5fa', // Blue
  '#818cf8', // Indigo
  '#c084fc', // Purple
  '#f472b6', // Pink
];

export const PEER_COLOR_PALETTE: readonly string[] = Object.freeze(PEER_COLORS);

/** FNV-1a: small, fast, and stable across engines (unlike `String.hashCode` shims). */
export function hashString(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function getPeerColor(clientId: number): string {
  const index = Math.abs(Math.trunc(clientId)) % PEER_COLORS.length;
  return PEER_COLORS[index];
}

/** Same peer, same colour, even before a Yjs client ID has been assigned. */
export function getPeerColorByName(name: string): string {
  return PEER_COLORS[hashString(name) % PEER_COLORS.length];
}

/** Converts an HSL triple to a 6-digit uppercase hex string. */
export function hslToHex(h: number, s: number, l: number): string {
  const hue = ((h % 360) + 360) % 360;
  const saturation = Math.min(100, Math.max(0, s)) / 100;
  const lightness = Math.min(100, Math.max(0, l)) / 100;

  const c = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = lightness - c / 2;

  let rgb: [number, number, number];
  if (hue < 60) rgb = [c, x, 0];
  else if (hue < 120) rgb = [x, c, 0];
  else if (hue < 180) rgb = [0, c, x];
  else if (hue < 240) rgb = [0, x, c];
  else if (hue < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];

  const toHex = (channel: number): string =>
    Math.round((channel + m) * 255)
      .toString(16)
      .padStart(2, '0');

  return `#${toHex(rgb[0])}${toHex(rgb[1])}${toHex(rgb[2])}`;
}

/**
 * Derives a hex colour from any seed string. Saturation/lightness are fixed to
 * values that keep a 2px cursor line readable against the `#1e1e1e` editor
 * background, while the hue spans the full wheel.
 */
export function colorFromSeed(seed: string): string {
  const hash = hashString(seed);
  const hue = hash % 360;
  const saturation = 62 + ((hash >>> 9) % 18);
  const lightness = 52 + ((hash >>> 17) % 14);
  return hslToHex(hue, saturation, lightness);
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const normalized = hex.replace('#', '');
  const expanded =
    normalized.length === 3
      ? normalized
          .split('')
          .map((character) => character + character)
          .join('')
      : normalized;
  const value = Number.parseInt(expanded, 16);
  if (Number.isNaN(value)) return { r: 255, g: 255, b: 255 };
  return {
    r: (value >> 16) & 255,
    g: (value >> 8) & 255,
    b: value & 255,
  };
}

/** Produces `rgba(...)` for translucent selection highlights. */
export function hexToRgba(hex: string, alpha: number): string {
  const { r, g, b } = hexToRgb(hex);
  const clamped = Math.min(1, Math.max(0, alpha));
  return `rgba(${r}, ${g}, ${b}, ${clamped.toFixed(3)})`;
}

/** Picks black or white text for readable contrast against a peer colour. */
export function getContrastColor(hex: string): '#000000' | '#ffffff' {
  const { r, g, b } = hexToRgb(hex);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? '#000000' : '#ffffff';
}

const ADJECTIVES = [
  'Swift', 'Agile', 'Bright', 'Clever', 'Quiet', 'Wired', 'Hyper', 'Sonic',
  'Nimble', 'Brave', 'Calm', 'Keen',
] as const;

const NOUNS = [
  'Coder', 'Hacker', 'Builder', 'Dev', 'Engineer', 'Architect', 'Scripter', 'Pilot',
] as const;

export function generateRandomUsername(): string {
  const adjective = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  const number = Math.floor(100 + Math.random() * 900);
  return `${adjective}${noun}#${number}`;
}

export function generateInitials(name: string): string {
  const parts = name
    .replace(/[^A-Za-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  if (parts.length === 0) return '??';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

const IDENTITY_STORAGE_KEY = 'LANCodeCollab:peer-identity';

const isStorageAvailable = (): boolean => {
  try {
    return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
  } catch {
    return false;
  }
};

/**
 * Reads the persisted identity so a user keeps their name and cursor colour
 * across reloads (offline-first requirement: identity survives a cold start).
 */
export function loadLocalIdentity(): LocalPeerIdentity | null {
  if (!isStorageAvailable()) return null;

  try {
    const raw = window.localStorage.getItem(IDENTITY_STORAGE_KEY);
    if (!raw) return null;

    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;

    const candidate = parsed as Record<string, unknown>;
    if (
      typeof candidate.name !== 'string' ||
      typeof candidate.color !== 'string' ||
      typeof candidate.clientId !== 'number'
    ) {
      return null;
    }

    return {
      clientId: candidate.clientId,
      name: candidate.name,
      color: candidate.color,
    };
  } catch {
    return null;
  }
}

export function saveLocalIdentity(identity: LocalPeerIdentity): void {
  if (!isStorageAvailable()) return;

  try {
    window.localStorage.setItem(IDENTITY_STORAGE_KEY, JSON.stringify(identity));
  } catch {
    // Private-mode storage denials must never break the collaboration session.
  }
}

export function clearLocalIdentity(): void {
  if (!isStorageAvailable()) return;
  try {
    window.localStorage.removeItem(IDENTITY_STORAGE_KEY);
  } catch {
    // Ignore: clearing identity is best-effort.
  }
}

/** Resolves the identity to use for this browser, creating one on first run. */
export function resolveLocalIdentity(clientId: number): LocalPeerIdentity {
  const existing = loadLocalIdentity();
  if (existing) {
    const refreshed: LocalPeerIdentity = { ...existing, clientId };
    saveLocalIdentity(refreshed);
    return refreshed;
  }

  const created: LocalPeerIdentity = {
    clientId,
    name: generateRandomUsername(),
    color: getPeerColor(clientId),
  };
  saveLocalIdentity(created);
  return created;
}