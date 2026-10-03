/**
 * Minimal `process` shim injected into the verification bundle.
 *
 * Monaco's ESM build (and a few of its dependencies) reference `process.env`
 * even though they only ever run in a browser. esbuild's `inject` substitutes
 * free identifiers, so this fills the gap without touching the application code.
 */

const nodeProcess = globalThis.process ?? {};

const processShim = {
  env: nodeProcess.env ?? {},
  platform: nodeProcess.platform ?? 'browser',
  version: nodeProcess.version ?? 'v0.0.0',
  cwd: () => '/',
  nextTick: (callback, ...args) => queueMicrotask(() => callback(...args)),
  on: () => processShim,
  off: () => processShim,
  once: () => processShim,
  removeListener: () => processShim,
  emit: () => false,
};

export { processShim as process };