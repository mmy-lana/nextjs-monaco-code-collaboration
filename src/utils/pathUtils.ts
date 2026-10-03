export function normalizePath(path: string): string {
  const parts = path.split('/').filter(Boolean);
  const stack: string[] = [];

  for (const part of parts) {
    if (part === '..') {
      stack.pop();
    } else if (part !== '.') {
      stack.push(part);
    }
  }

  return '/' + stack.join('/');
}

export function getFileExtension(filename: string): string {
  const lastIndex = filename.lastIndexOf('.');
  if (lastIndex === -1 || lastIndex === 0) return '';
  return filename.substring(lastIndex + 1).toLowerCase();
}

export function getParentPath(path: string): string {
  const normalized = normalizePath(path);
  const segments = normalized.split('/').filter(Boolean);
  if (segments.length <= 1) return '/';
  segments.pop();
  return '/' + segments.join('/');
}

export function getFileName(path: string): string {
  const segments = normalizePath(path).split('/').filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : '';
}
