/**
 * Monaco language-service worker entry points.
 *
 * These modules exist so the bundler can emit each language service as its own
 * standalone module worker; Monaco is served from the app's own origin, which
 * keeps the offline/LAN guarantee intact (no CDN worker).
 */
import 'monaco-editor/editor/editor.worker.js';
