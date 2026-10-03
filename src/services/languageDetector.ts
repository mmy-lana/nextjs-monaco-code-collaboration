import { getFileExtension } from '@/utils/pathUtils';

/**
 * Maps workspace file names onto Monaco language identifiers.
 *
 * `plaintext` is Monaco's neutral fallback and is always available, so the
 * detector never fails — unknown files simply get no syntax highlighting.
 */

const EXTENSION_MAP: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  less: 'less',
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
  py: 'python',
  pyi: 'python',
  rs: 'rust',
  go: 'go',
  sql: 'sql',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  fish: 'shell',
  ps1: 'powershell',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  cfg: 'ini',
  conf: 'ini',
  xml: 'xml',
  svg: 'xml',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  rb: 'ruby',
  php: 'php',
  lua: 'lua',
  dart: 'dart',
  scala: 'scala',
  vue: 'html',
  svelte: 'html',
  graphql: 'graphql',
  gql: 'graphql',
  proto: 'proto',
  dockerfile: 'dockerfile',
  txt: 'plaintext',
  log: 'plaintext',
  env: 'ini',
  gitignore: 'plaintext',
};

/** Files that carry no extension but map to a specific language. */
const FILENAME_MAP: Record<string, string> = {
  dockerfile: 'dockerfile',
  containerfile: 'dockerfile',
  makefile: 'plaintext',
  'cmakelists.txt': 'plaintext',
  '.gitignore': 'plaintext',
  '.env': 'ini',
  '.editorconfig': 'ini',
  '.prettierrc': 'json',
  '.babelrc': 'json',
  'package.json': 'json',
  'tsconfig.json': 'json',
};

export const FALLBACK_LANGUAGE = 'plaintext';

export function detectLanguageByFilename(filename: string): string {
  if (!filename) return FALLBACK_LANGUAGE;

  const lowerName = filename.toLowerCase();

  // Whole-name matches win over extension matches (`Dockerfile.prod`).
  if (FILENAME_MAP[lowerName]) return FILENAME_MAP[lowerName];

  const withoutExtension = lowerName.includes('.') ? lowerName.slice(0, lowerName.lastIndexOf('.')) : lowerName;
  if (FILENAME_MAP[withoutExtension]) return FILENAME_MAP[withoutExtension];

  const extension = getFileExtension(lowerName);
  if (!extension) return FALLBACK_LANGUAGE;

  return EXTENSION_MAP[extension] ?? FALLBACK_LANGUAGE;
}

/** Accepts either a bare file name or a full virtual path. */
export function detectLanguageByPath(path: string): string {
  const segments = path.split('/').filter(Boolean);
  return detectLanguageByFilename(segments[segments.length - 1] ?? '');
}

/** Every language this workspace can produce, used to validate remote payloads. */
export const SUPPORTED_LANGUAGES: readonly string[] = Object.freeze([
  ...new Set([...Object.values(EXTENSION_MAP), ...Object.values(FILENAME_MAP), FALLBACK_LANGUAGE]),
].sort());

export function isSupportedLanguage(language: string): boolean {
  return SUPPORTED_LANGUAGES.includes(language);
}

/**
 * Coerces an untrusted language identifier (for example one relayed by a peer)
 * into a Monaco-safe value, falling back to `plaintext`.
 */
export function resolveMonacoLanguage(language: string | null | undefined): string {
  if (!language) return FALLBACK_LANGUAGE;
  return isSupportedLanguage(language) ? language : FALLBACK_LANGUAGE;
}