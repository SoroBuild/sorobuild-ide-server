import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { runJob } from '../lib/runner.js';
const files = {};
for (const file of ['Cargo.toml','Cargo.lock','src/lib.rs','src/test.rs']) files[file] = await readFile(`runner-template/${file}`, 'utf8');
for (const action of ['build', 'test', 'format']) {
  const result = await runJob(action, { files, manifest: 'Cargo.toml' });
  assert.equal(result.success, true, result.output);
  if (action === 'build') { assert.ok(result.artifacts.length); await writeFile('tests/artifact.local.json', JSON.stringify(result.artifacts[0])); }
  if (action === 'test') assert.match(result.output, /test result: ok/);
  if (action === 'format') assert.ok(result.files['src/lib.rs']);
  console.log(`${action}: passed`);
}
const workspace = { 'Cargo.toml': '[workspace]\nmembers=["contracts/alpha","contracts/beta"]\nresolver="2"\n[profile.release]\noverflow-checks=true\npanic="abort"\nopt-level="z"\n', 'Cargo.lock': files['Cargo.lock'] };
for (const name of ['alpha','beta']) for (const [file, value] of Object.entries(files)) if (file !== 'Cargo.lock') workspace[`contracts/${name}/${file}`] = file === 'Cargo.toml' ? value.replace('soroban-hello-world-contract', name) : value;
const multi = await runJob('build', { files: workspace, manifest: 'Cargo.toml' });
assert.equal(multi.success, true, multi.output); assert.deepEqual(multi.artifacts.map(a => a.name).sort(), ['alpha.wasm','beta.wasm']); console.log('Multi-contract build: passed');
workspace['contracts/alpha/src/lib.rs'] = 'broken Rust source';
const failed = await runJob('build', { files: workspace, manifest: 'Cargo.toml' });
assert.equal(failed.success, false); assert.equal(failed.artifacts.length, 0); console.log('Broken source has no stale artifacts: passed');
