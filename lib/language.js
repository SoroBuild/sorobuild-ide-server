import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,chmod,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createMessageConnection,StreamMessageReader,StreamMessageWriter} from 'vscode-languageserver-protocol/node.js';
import {validateFiles,validatePath} from './workspace.js';
import {fail} from './store.js';
import {runProcess} from './runner.js';
const methods = new Set(['textDocument/completion','textDocument/hover','textDocument/signatureHelp','textDocument/definition']);
export function validateLanguageInput(input) {
  const files=validateFiles(input.files);validatePath(input.path);
  if (!Object.hasOwn(files,input.path) || !input.path.endsWith('.rs')) throw fail(400,'Choose a Rust source file.');
  if (!methods.has(input.method)) throw fail(400,'Unsupported language request.');
  if (!Number.isInteger(input.position?.line) || input.position.line<0 || !Number.isInteger(input.position?.character) || input.position.character<0) throw fail(400,'Invalid editor position.');
  const lines=files[input.path].split('\n');
  if (input.position.line>=lines.length || input.position.character>lines[input.position.line].length) throw fail(400,'Editor position is outside the document.');
  if (Object.keys(files).some(file=>file.split('/').includes('.cargo') || /(^|\/)rust-toolchain(\.toml)?$/.test(file))) throw fail(400,'Custom Cargo configurations and toolchains are not supported.');
  if (!Object.keys(files).some(file=>/(^|\/)Cargo.toml$/.test(file))) throw fail(400,'Load a Cargo project to enable IntelliSense.');
  return files;
}
const uriFor = file => 'file:///tmp/project/'+file.split('/').map(encodeURIComponent).join('/');
const configuration = {cargo:{offline:true,buildScripts:{enable:true}},procMacro:{enable:true},checkOnSave:false,diagnostics:{enable:true},completion:{autoimport:{enable:false}},files:{excludeDirs:['target','.git']}};
function deadline(promise,ms=90000) {
  let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(fail(503,'Rust analysis is still starting. Retry shortly.')),ms);})]).finally(()=>clearTimeout(timer));
}
async function startLanguage(files) {
  const jobsRoot=process.env.JOBS_DIR||tmpdir();await mkdir(jobsRoot,{recursive:true});
  const dir=await mkdtemp(path.join(jobsRoot,'sorobuild-lsp-'));await chmod(dir,0o755);
  const name='sorobuild-lsp-'+randomUUID();let child,connection,ready=false,closed=false;
  const diagnostics=new Map(),opened=new Map();let version=0,lastError='';
  const close=async()=>{
    if(closed)return;closed=true;connection?.dispose();child?.kill('SIGTERM');
    await runProcess('docker',['rm','-f',name],{timeout:10000}).catch(()=>{});
    await rm(dir,{recursive:true,force:true});
  };
  try {
    for(const [file,text]of Object.entries(files)){await mkdir(path.dirname(path.join(dir,file)),{recursive:true});await writeFile(path.join(dir,file),text);}
    child=spawn('docker',['run','--rm','-i','--name',name,'--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--pids-limit=256','--memory=4g','--cpus=2','--user=65534:65534','--tmpfs','/tmp:rw,exec,nosuid,size=4g,mode=1777','--mount',`type=bind,source=${dir},target=/input,readonly`,'-e','CARGO_TARGET_DIR=/tmp/target','-e','CARGO_NET_OFFLINE=true','--entrypoint','/bin/sh',process.env.SOROBUILD_RUNNER_IMAGE||'sorobuild-runner:25','-c','cp -R /input /tmp/project && cd /tmp/project && exec rust-analyzer'],{stdio:['pipe','pipe','pipe']});
    const exited=new Promise((_,reject)=>{child.once('error',()=>reject(fail(503,'Language runner could not start. Verify Docker is running.')));child.once('exit',()=>reject(fail(503,'Language runner exited. Verify Docker and the runner image.')));});
    child.on('error',error=>{lastError=error.message;});child.stderr.on('data',chunk=>{lastError=(lastError+chunk.toString()).slice(-2000);});
    let output=0;child.stdout.on('data',chunk=>{output+=chunk.length;if(output>32*1024*1024)child.kill('SIGKILL');});
    connection=createMessageConnection(new StreamMessageReader(child.stdout),new StreamMessageWriter(child.stdin));
    connection.onRequest('workspace/configuration',params=>params.items.map(()=>configuration));
    connection.onRequest('window/workDoneProgress/create',()=>null);
    connection.onRequest('client/registerCapability',()=>null);
    connection.onNotification('experimental/serverStatus',status=>{ready=status.quiescent;});
    connection.onNotification('textDocument/publishDiagnostics',params=>{if(params.uri.startsWith('file:///tmp/project/')) diagnostics.set(params.uri,params.diagnostics.slice(0,200));});
    connection.listen();
    await deadline(Promise.race([exited,connection.sendRequest('initialize',{processId:null,rootUri:'file:///tmp/project',workspaceFolders:[{uri:'file:///tmp/project',name:'Soroban workspace'}],capabilities:{workspace:{configuration:true},textDocument:{completion:{completionItem:{snippetSupport:true}},hover:{contentFormat:['markdown','plaintext']}},experimental:{serverStatusNotification:true}},initializationOptions:{...configuration,linkedProjects:Object.keys(files).filter(file=>/(^|\/)Cargo.toml$/.test(file)).map(file=>'/tmp/project/'+file)}})]));
    await connection.sendNotification('initialized',{});
    return {close,async request(input){
      if(closed || child.exitCode!==null)throw fail(502,'Rust language server stopped. Retry to restart it.');
      for(const [file,text]of Object.entries(input.files).filter(([file])=>file.endsWith('.rs'))){
        if(opened.get(file)===text)continue;
        const uri=uriFor(file);
        if(!opened.has(file))await connection.sendNotification('textDocument/didOpen',{textDocument:{uri,languageId:'rust',version:++version,text}});
        else await connection.sendNotification('textDocument/didChange',{textDocument:{uri,version:++version},contentChanges:[{text}]});
        opened.set(file,text);
      }
      const end=Date.now()+90000;
      while(!ready && Date.now()<end && child.exitCode===null)await new Promise(resolve=>setTimeout(resolve,100));
      if(!ready)throw fail(child.exitCode===null?503:502,child.exitCode===null?'Indexing the Soroban SDK. Retry shortly.':'Rust language server could not load this workspace.');
      const result=await deadline(connection.sendRequest(input.method,{textDocument:{uri:uriFor(input.path)},position:input.position}),15000);
      return {result,diagnostics:Object.fromEntries([...diagnostics].map(([uri,items])=>[decodeURIComponent(uri.slice('file:///tmp/project/'.length)),items]))};
    }};
  } catch(error){await close();throw fail(503,`Rust IntelliSense could not start. Verify the runner image includes rust-analyzer. ${error.message || lastError}`);}
}
export function createLanguageService({start=startLanguage,maxSessions=2,idleMs=300000}={}) {
  const sessions=new Map();
  const reap=setInterval(()=>{for(const [id,entry]of sessions)if(!entry.pending && Date.now()-entry.used>idleMs){sessions.delete(id);entry.session?.close().catch(()=>{});}},Math.min(idleMs,30000));reap.unref();
  return {
    async request(id,input){
      const files=validateLanguageInput(input);
      const fingerprint=createHash('sha256').update(JSON.stringify(Object.entries(files).map(([file,text])=>[file,file.endsWith('.rs')?'':text]).sort(([a],[b])=>a.localeCompare(b)))).digest('hex');
      let entry=sessions.get(id);
      if(!entry){if(sessions.size>=maxSessions)throw fail(429,'IntelliSense capacity is full. Retry after another session is idle.');entry={session:null,fingerprint:'',queue:Promise.resolve(),pending:0,used:Date.now()};sessions.set(id,entry);}
      if(entry.pending>=4)throw fail(429,'Editor analysis is busy. Retry shortly.');entry.pending++;entry.used=Date.now();
      const task=entry.queue.catch(()=>{}).then(async()=>{
        if(entry.fingerprint!==fingerprint){await entry.session?.close();entry.session=null;entry.fingerprint='';entry.session=await start(files);entry.fingerprint=fingerprint;}
        try{return await entry.session.request({...input,files});}
        catch(error){if(error.status!==503){await entry.session.close();entry.session=null;entry.fingerprint='';}throw error;}
      });
      entry.queue=task;try{return await task;}finally{entry.pending--;entry.used=Date.now();if(!entry.pending && !entry.session && sessions.get(id)===entry)sessions.delete(id);}
    },
    async remove(id){const entry=sessions.get(id);if(!entry)return;await entry.queue.catch(()=>{});await entry.session?.close();if(sessions.get(id)===entry)sessions.delete(id);},
    async close(){clearInterval(reap);await Promise.allSettled([...sessions.values()].map(async entry=>{await entry.queue.catch(()=>{});await entry.session?.close();}));sessions.clear();}
  };
}
