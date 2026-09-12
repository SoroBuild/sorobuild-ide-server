import test from 'node:test';
import assert from 'node:assert/strict';
import {fundTestAccount} from '../lib/funding.js';
const address='GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
test('funding allows only fixed test networks and valid public keys',async()=>{
 let calls=0;const request=async(url,options)=>{calls++;if(options?.body) {const key=JSON.parse(options.body).params.keys[0]; return {ok:true,json:async()=>({result:{entries:[{key}]}})};} return {ok:true};};
 await assert.rejects(fundTestAccount({network:'mainnet',address},request),/Testnet/);
 await assert.rejects(fundTestAccount({network:'https://localhost',address},request),/Testnet/);
 await assert.rejects(fundTestAccount({network:'testnet',address:address.slice(0,-1)+'A'},request),/valid Stellar/);assert.equal(calls,0);
 assert.deepEqual(await fundTestAccount({network:'testnet',address},request),{funded:true,address,network:'testnet'});assert.equal(calls,2);
});
test('funding verifies an existing account after a rejected duplicate and reports network errors',async()=>{
 let calls=0;const request=async(url,options)=>{calls++;if(calls===1)return {ok:false,status:400};assert.equal(url,'https://soroban-testnet.stellar.org');const key=JSON.parse(options.body).params.keys[0];assert.equal(Buffer.from(key,'base64').length,40);return {ok:true,json:async()=>({result:{entries:[{key}]}})};};
 assert.equal((await fundTestAccount({network:'testnet',address},request)).funded,true);
 await assert.rejects(fundTestAccount({network:'testnet',address},async()=>{throw new Error('DNS');}),/key is retained/);
});

test('successful faucet response waits for RPC visibility before reporting funded',async()=>{
 let rpcCalls=0;
 const result=await fundTestAccount({network:'testnet',address},async(url,options)=>{
  if(!options.body)return {ok:true,status:200};
  const key=JSON.parse(options.body).params.keys[0];rpcCalls++;
  return {ok:true,json:async()=>({result:{entries:rpcCalls<2?[]:[{key}]}})};
 });
 assert.equal(result.funded,true);assert.equal(rpcCalls,2);
});
test('successful faucet response alone does not establish funding',async()=>{
 await assert.rejects(fundTestAccount({network:'testnet',address},async()=>({ok:true,status:200,json:async()=>({result:{entries:[]}})})),/could not be verified/);
});
