import test from 'node:test';
import assert from 'node:assert/strict';
import { validateFiles, validatePath, renameFiles, manifestPaths, shouldImport } from '../lib/workspace.js';
const starterFiles = { 'Cargo.toml': '', 'contracts/counter/src/lib.rs': '', 'contracts/counter/Cargo.toml': '' };

test('accepts a workspace with nested manifests and empty files', () => {
  const files = validateFiles({ ...starterFiles, 'empty.rs': '' });
  assert.equal(files['empty.rs'], '');
  assert.deepEqual(manifestPaths(files), ['Cargo.toml', 'contracts/counter/Cargo.toml']);
});
test('rejects traversal, prototype keys, absolute paths, and file/folder collisions', () => {
  for (const path of ['../secret', '/tmp/a', 'a//b', 'a/./b', 'a\\b', '__proto__/x', 'constructor/x', 'a\0b', 'C:/a']) assert.throws(() => validatePath(path));
  assert.throws(() => validateFiles({ a: '', 'a/b': '' }), /conflict/);
  assert.throws(() => validateFiles({ 'a.rs': {} }), /text/);
  assert.throws(() => validateFiles([]));
});
test('rejects oversized content and excessive files', () => {
  assert.throws(() => validateFiles({ 'huge.rs': 'a'.repeat(4 * 1024 * 1024) }), /4 MiB/);
  assert.throws(() => validateFiles(Object.fromEntries(Array.from({ length: 501 }, (_, n) => [`${n}.rs`, '']))), /500/);
});
test('rename preserves nested files and prevents overwrites in either iteration order', () => {
  assert.deepEqual(renameFiles({ 'a/x.rs': '', 'a/y.rs': 'y' }, 'a', 'b'), { 'b/x.rs': '', 'b/y.rs': 'y' });
  for (const files of [{ a: 'a', b: 'b' }, { b: 'b', a: 'a' }]) assert.throws(() => renameFiles(files, 'a', 'b'), /overwrite/);
  assert.throws(() => renameFiles({ 'a/x': '' }, 'a', 'a/b'));
});
test('folder imports omit build output, version control and secrets', () => {
  for (const file of ['target/a.wasm', '.git/config', 'node_modules/a.js', '.env', '.env.local', '.cargo/config.toml']) assert.equal(shouldImport(file), false);
  assert.equal(shouldImport('contracts/counter/src/lib.rs'), true);
});
