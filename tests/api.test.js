import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { createApp } from '../app.js';
import { FileStore } from '../lib/store.js';
import { encodeArchive, decodeArchive } from '../lib/archive.js';
async function harness(t, execute = async () => ({ success: false, output: 'error: bad Rust', artifacts: [] }), language) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ide-api-test-')), store = new FileStore(dir); await store.init();
  const server = createApp({ store, execute, language }).listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`, files = { 'Cargo.toml': '[package]', 'src/lib.rs': '' };
  const created = await fetch(`${base}/api/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ files }) });
  assert.equal(created.status, 201); const project = await created.json();
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${project.projectToken}`, 'X-Project-Revision': '1' };
  const url = `${base}/api/projects/${project.projectId}`;
  return { url, base, files, project, headers, store };
}
test('owner access, atomic persistence, empty files and stale revisions', async t => {
  const { url, files, headers, store, project } = await harness(t);
  assert.equal((await fetch(url)).status, 403);
  assert.equal((await fetch(url, { headers: { Authorization: 'Bearer wrong' } })).status, 403);
  const loaded = await fetch(`${url}/load`, { headers }); assert.deepEqual(await decodeArchive(Buffer.from(await loaded.arrayBuffer())), files);
  const updated = { ...files, 'src/lib.rs': 'new source' };
  assert.equal((await fetch(url, { method: 'PUT', headers, body: JSON.stringify({ files: updated }) })).status, 200);
  assert.equal((await fetch(url, { method: 'PUT', headers, body: JSON.stringify({ files }) })).status, 409);
  assert.deepEqual((await new FileStore(store.directory).get(project.projectId)).files, updated);
});
test('failed jobs do not overwrite saved source', async t => {
  const { url, files, headers, store, project } = await harness(t);
  const result = await fetch(`${url}/build`, { method: 'POST', headers, body: JSON.stringify({ files: { ...files, 'src/lib.rs': 'broken' }, manifest: 'Cargo.toml' }) });
  assert.equal(result.status, 422); assert.equal((await result.json()).success, false);
  assert.deepEqual((await store.get(project.projectId)).files, files);
});
test('concurrent jobs cannot enter the same project', async t => {
  let release, enter; const started = new Promise(resolve => { enter = resolve; });
  const { url, files, headers } = await harness(t, () => { enter(); return new Promise(resolve => { release = resolve; }); });
  const options = { method: 'POST', headers, body: JSON.stringify({ files, manifest: 'Cargo.toml' }) };
  const pending = fetch(`${url}/test`, options); await started;
  assert.equal((await fetch(`${url}/test`, options)).status, 409);
  release({ success: true, output: 'test works ... ok', artifacts: [] }); assert.equal((await pending).status, 200);
});
test('rejects cross-origin requests, invalid inputs and missing delete revisions', async t => {
  const { url, base, headers } = await harness(t);
  assert.equal((await fetch(`${base}/api/health`, { headers: { Origin: 'https://evil.test' } })).status, 403);
  assert.equal((await fetch(`${base}/api/projects`, { method: 'POST' })).status, 400);
  assert.equal((await fetch(`${base}/api/projects/no-id`, { headers })).status, 400);
  assert.equal((await fetch(`${url}/delete`, { method: 'POST', headers: { Authorization: headers.Authorization } })).status, 428);
});
test('ZIP import rejects traversal, symlinks, collisions and decompression bombs', async () => {
  for (const [name, content, options] of [['../secret', 'x', {}], ['link', 'dest', { unixPermissions: 0o120777 }], ['huge.rs', 'x'.repeat(4 * 1024 * 1024 + 1), {}]]) {
    const zip = new JSZip(); zip.file(name, content, options);
    await assert.rejects(decodeArchive(await zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX', compression: 'DEFLATE' })));
  }
  const zip = new JSZip(); zip.file('a', 'x'); zip.file('a/b', 'y'); await assert.rejects(decodeArchive(await zip.generateAsync({ type: 'nodebuffer' })));
  assert.deepEqual(await decodeArchive(await encodeArchive({ 'empty.rs': '' })), { 'empty.rs': '' });
});

test('language analysis requires the owner token and never saves editor changes',async t=>{
 let calls=0;const language={request:async()=>{calls++;return {result:{items:[]},diagnostics:{}};}};
 const {url,headers,store,project,files}=await harness(t,undefined,language);
 const body=JSON.stringify({files:{...files,'src/lib.rs':'unsaved'},path:'src/lib.rs',method:'textDocument/completion',position:{line:0,character:0}});
 assert.equal((await fetch(`${url}/language`,{method:'POST',headers:{'Content-Type':'application/json'},body})).status,403);
 assert.equal(calls,0);
 assert.equal((await fetch(`${url}/language`,{method:'POST',headers,body})).status,200);
 assert.equal(calls,1);assert.deepEqual((await store.get(project.projectId)).files,files);
});

test('build streams compiler output before completion and keeps authentication',async t=>{
 let release;const gate=new Promise(resolve=>{release=resolve;});
 const {url,headers,files}=await harness(t,async(_action,_input,{onOutput})=>{onOutput('Compiling counter\n');await gate;return {success:true,output:'Compiling counter\n',artifacts:[]};});
 const options={method:'POST',headers:{...headers,Accept:'application/x-ndjson'},body:JSON.stringify({files,manifest:'Cargo.toml'})};
 const response=await fetch(`${url}/build`,options);const reader=response.body.getReader();
 const first=JSON.parse(new TextDecoder().decode((await reader.read()).value).trim());assert.equal(first.type,'log');assert.match(first.text,/Compiling/);
 release();let rest='';while(true){const {done,value}=await reader.read();if(done)break;rest+=new TextDecoder().decode(value);}assert.equal(JSON.parse(rest.trim()).result.success,true);
 assert.equal((await fetch(`${url}/build`,{...options,headers:{'Content-Type':'application/json',Accept:'application/x-ndjson'}})).status,403);
});
