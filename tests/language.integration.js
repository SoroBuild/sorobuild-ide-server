import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createLanguageService} from '../lib/language.js';

// Exercise the real Docker runner and SDK, not a mocked LSP response.
const files = {};
for (const file of ['Cargo.toml', 'Cargo.lock']) files[file] = await readFile(`runner-template/${file}`, 'utf8');
files['src/lib.rs'] = '#![no_std]\nuse soroban_sdk::Env;\npub fn probe(env: Env) { env.sto }\n';
const service = createLanguageService();
try {
  const input = {files, path:'src/lib.rs', method:'textDocument/completion', position:{line:2, character:32}};
  const {result} = await service.request('sdk-completion', input);
  const items = Array.isArray(result) ? result : result?.items || [];
  assert.ok(items.some(item => item.label.startsWith('storage')), 'Expected real Soroban Env.storage completion');
  const hover = await service.request('sdk-completion', {...input, method:'textDocument/hover', position:{line:1, character:18}});
  assert.ok(hover.result?.contents, 'Expected SDK Env hover documentation');
  console.log('Real Soroban SDK completion and hover: passed');
} finally {
  await service.close();
}
