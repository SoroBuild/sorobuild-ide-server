import test from 'node:test';
import assert from 'node:assert/strict';
import {createLanguageService,validateLanguageInput,languageStatusError} from '../lib/language.js';
const input={files:{'Cargo.toml':'[package]\nname="test"','src/lib.rs':'fn main() {}'},path:'src/lib.rs',method:'textDocument/completion',position:{line:0,character:3}};
test('language input blocks invalid paths, operations and toolchain overrides',()=>{
 assert.throws(()=>validateLanguageInput({...input,path:'../secret'}));
 assert.throws(()=>validateLanguageInput({...input,method:'workspace/executeCommand'}));
 assert.throws(()=>validateLanguageInput({...input,files:{...input.files,'rust-toolchain.toml':'nightly'}}));
 assert.throws(()=>validateLanguageInput({...input,position:{line:100,character:0}}));
});
test('language sessions reuse Rust edits, restart for manifests and isolate projects',async()=>{
 let starts=0,closes=0;const service=createLanguageService({start:async()=>{starts++;return {request:async value=>({text:value.files['src/lib.rs']}),close:async()=>{closes++;}};},maxSessions:1});
 try {
  await service.request('first',input);
  const edited={...input,files:{...input.files,'src/lib.rs':'fn changed() {}'}};
  assert.equal((await service.request('first',edited)).text,'fn changed() {}');assert.equal(starts,1);
  await service.request('first',{...edited,files:{...edited.files,'Cargo.toml':'changed'}});assert.equal(starts,2);assert.equal(closes,1);
  await assert.rejects(service.request('second',input),/capacity/);
 }finally{await service.close();}
 assert.equal(closes,2);
});

test('failed startup and deleted projects release language capacity',async()=>{
 let starts=0,closed=0;
 const service=createLanguageService({maxSessions:1,start:async()=>{if(++starts===1)throw new Error('Docker unavailable');return {request:async()=>({result:null}),close:async()=>{closed++;}};}});
 try {
  await assert.rejects(service.request('failed',input),/Docker/);
  await service.request('first',input);await service.remove('first');
  await service.request('second',input);assert.equal(closed,1);
 }finally{await service.close();}
 assert.equal(closed,2);
});

test('cancelled analysis releases the queue and preserves the warm session',async()=>{
 let starts=0,closes=0,requests=0,started;
 const entered=new Promise(resolve=>{started=resolve;});
 const service=createLanguageService({start:async()=>{starts++;return {
  close:async()=>{closes++;},
  request:async(_input,{signal})=>{requests++;if(requests===1){started();await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(new Error('cancelled'),{status:499})),{once:true}));}return {result:'storage'};}
 };}});
 try {
  const active=new AbortController(),queued=new AbortController();
  const first=service.request('counter',input,{signal:active.signal});
  const rejectedFirst=assert.rejects(first,error=>error.status===499);
  await entered;
  const pending=service.request('counter',input,{signal:queued.signal});
  const rejectedPending=assert.rejects(pending,error=>error.status===499);
  queued.abort();active.abort();await Promise.all([rejectedFirst,rejectedPending]);
  assert.equal((await service.request('counter',input)).result,'storage');
  assert.equal(starts,1);assert.equal(closes,0);assert.equal(requests,2);
 }finally{await service.close();}
 assert.equal(closes,1);
});

test('Cargo metadata failures are reported instead of declaring SDK analysis ready',()=>{
 assert.match(languageStatusError({health:'warning',quiescent:true,message:'Failed to read Cargo metadata: no matching package named `assert_unordered` found'}),/assert_unordered.*runner cache/);
 assert.match(languageStatusError({health:'warning',message:'Failed to read Cargo metadata: version conflict'}),/version conflict/);
 assert.equal(languageStatusError({health:'ok',quiescent:true}),null);
 assert.equal(languageStatusError({health:'warning',message:'proc macro expansion is unavailable'}),null);
});
