import { fail } from './store.js';
const networks={testnet:{faucet:'https://friendbot.stellar.org',rpc:'https://soroban-testnet.stellar.org'},futurenet:{faucet:'https://friendbot-futurenet.stellar.org',rpc:'https://rpc-futurenet.stellar.org'}};
function accountKey(address){
 const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';let value=0,bits=0;const bytes=[];
 for(const character of address){value=(value<<5)|alphabet.indexOf(character);bits+=5;if(bits>=8){bits-=8;bytes.push((value>>>bits)&255);}}
 const decoded=Buffer.from(bytes);let crc=0;for(const byte of decoded.subarray(0,33)){crc^=byte<<8;for(let bit=0;bit<8;bit++)crc=((crc<<1)^((crc&0x8000)?0x1021:0))&0xffff;}
 if(decoded[0]!==48 || decoded.readUInt16LE(33)!==crc)throw fail(400,'Enter a valid Stellar public account address.');
 return Buffer.concat([Buffer.alloc(8),decoded.subarray(1,33)]).toString('base64');
}
export async function fundTestAccount({network,address}={},request=fetch){
 const endpoints=networks[network];if(!endpoints)throw fail(400,'Funding is available for Testnet and Futurenet only.');
 if(typeof address!=='string'||!/^G[A-Z2-7]{55}$/.test(address))throw fail(400,'Enter a valid Stellar public account address.');
 const key=accountKey(address);
 let faucetStatus;
 try {
  const funded=await request(`${endpoints.faucet}?addr=${encodeURIComponent(address)}`,{signal:AbortSignal.timeout(30000)});
  faucetStatus=funded.status;
 } catch { /* A lost faucet response may still have created the account. */ }
 for(let attempt=0;attempt<4;attempt++) {
  try {
   const response=await request(endpoints.rpc,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getLedgerEntries',params:{keys:[key]}}),signal:AbortSignal.timeout(4000)});
   const result=await response.json();
   if(response.ok&&result.result?.entries?.some(entry=>entry.key===key))return {funded:true,address,network};
  } catch { /* Retry while the RPC catches up with the funding transaction. */ }
  if(attempt<3)await new Promise(resolve=>setTimeout(resolve,500));
 }
 throw fail(502,`Funding could not be verified on ${network}${faucetStatus ? ` (Friendbot HTTP ${faucetStatus})` : ''}. Your key is retained; retry funding shortly.`);
}
