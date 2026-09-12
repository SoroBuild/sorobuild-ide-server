export const MAX_FILES = 500;
export const MAX_BYTES = 4 * 1024 * 1024;
const reserved = new Set(['__proto__', 'prototype', 'constructor', '__file', '__folder', 'path']);

export function validatePath(path) {
  if (typeof path !== 'string' || !path || path.length > 240 || /[\\:]/.test(path) || [...path].some(char => char.charCodeAt(0) < 32) ||
      path.split('/').some(part => !part || part === '.' || part === '..' || reserved.has(part))) {
    throw new Error(`Invalid workspace path: ${String(path).slice(0, 100)}`);
  }
  return path;
}

export function validateFiles(files) {
  if (!files || typeof files !== 'object' || Array.isArray(files)) throw new Error('Workspace files must be a path-to-text object.');
  const entries = Object.entries(files);
  if (entries.length > MAX_FILES) throw new Error(`Workspace exceeds ${MAX_FILES} files.`);
  let bytes = 0;
  for (const [path, content] of entries) {
    validatePath(path);
    if (typeof content !== 'string' || content.includes('\0')) throw new Error(`Only text source files are supported: ${path}`);
    bytes += new TextEncoder().encode(path + content).length;
    if (bytes > MAX_BYTES) throw new Error('Workspace exceeds 4 MiB. Exclude target, node_modules, and binary files.');
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      if (Object.hasOwn(files, parts.slice(0, i).join('/'))) throw new Error(`File/folder conflict at ${path}`);
    }
  }
  return Object.fromEntries(entries);
}

export function renameFiles(files, source, target) {
  validatePath(target);
  if (target.startsWith(`${source}/`)) throw new Error('A folder cannot be moved inside itself.');
  const result = {};
  for (const [path, value] of Object.entries(files)) {
    const renamed = path === source ? target : path.startsWith(`${source}/`) ? target + path.slice(source.length) : path;
    if (Object.hasOwn(result, renamed)) throw new Error(`Rename would overwrite ${renamed}`);
    result[renamed] = value;
  }
  return validateFiles(result);
}

export function manifestPaths(files) {
  return Object.keys(files).filter(path => path === 'Cargo.toml' || path.endsWith('/Cargo.toml')).sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
}

export function shouldImport(path) {
  return !path.endsWith('-test-key.json') && !path.split('/').some(part => ['target', 'node_modules', '.git', '.cargo', '.env', '.DS_Store'].includes(part) || part.startsWith('.env.'));
}
