import assert from 'node:assert/strict';
import {runJob} from '../lib/runner.js';
const files={'Cargo.toml':'[workspace]\nmembers=["contracts/a", "contracts/b"]\nresolver="2"\n'};
for(const name of ['a','b']){
files[`contracts/${name}/Cargo.toml`]=`[package]\nname="format-${name}"\nversion="0.1.0"\nedition="2021"\n[dependencies]\nnot-a-real-cached-dependency="99"\n`;
files[`contracts/${name}/src/lib.rs`]='pub fn sum(a:u32,b:u32)->u32{a+b}\n';
}
const start=Date.now();const result=await runJob('format',{files,manifest:'Cargo.toml'});
assert.equal(result.success,true,result.output);
for(const name of ['a','b'])assert.match(result.files[`contracts/${name}/src/lib.rs`],/pub fn sum\(a: u32, b: u32\) -> u32 \{\n    a \+ b\n\}/);
assert.equal(result.files['Cargo.toml'],files['Cargo.toml']);
console.log('WORKSPACE_FORMAT_OK',Date.now()-start,'ms');
files['contracts/a/src/lib.rs']='pub fn broken( {';
const broken=await runJob('format',{files,manifest:'Cargo.toml'});
assert.equal(broken.success,false);assert.equal(broken.files,undefined);assert.match(broken.output,/error/);
console.log('SYNTAX_ERROR_REPORTED');
