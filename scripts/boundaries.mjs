import { readFileSync,readdirSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
function files(dir){return readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(join(dir,e.name)):[join(dir,e.name)]);}
for(const file of files('packages/contracts/src')){
  const source=readFileSync(file,'utf8');
  assert(!/from\s+['"](?:node:|.*apps\/|.*server)/.test(source),`Forbidden contract import: ${file}`);
  assert(!/\bprocess\./.test(source),`Environment read in contract: ${file}`);
}
for(const file of files('apps/server/src')){
  const source=readFileSync(file,'utf8');assert(!/from\s+['"].*(?:apps\/web|@pulse\/web)/.test(source),`Forbidden server import: ${file}`);
  if(!file.includes('persistence'))assert(!/node:sqlite|\b(?:SELECT|INSERT INTO|UPDATE monitors|DELETE FROM)\b/.test(source),`SQL outside persistence: ${file}`);
}
console.log('Workspace dependency boundaries passed.');
for(const file of files('apps/web/src')){
  const source=readFileSync(file,'utf8');assert(!/from\s+['"](?:node:|.*apps\/server|@pulse\/server)/.test(source),`Forbidden browser import: ${file}`);
  assert(!/dangerouslySetInnerHTML|localStorage|sessionStorage/.test(source),`Unsafe browser persistence/rendering: ${file}`);
}
