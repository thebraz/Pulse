import { createHash } from 'node:crypto';
import { readFileSync,readdirSync,mkdirSync,writeFileSync } from 'node:fs';
import { join,relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { platform,release,arch } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { gzipSync } from 'node:zlib';

const npm=process.env.npm_execpath;
if(!npm)throw new Error('Run this command with npm run verify.');
const root=process.cwd(),out=join(root,'docs/evidence');mkdirSync(out,{recursive:true});
const initialManifest=sourceManifest();
const steps=[['run','typecheck'],['run','lint'],['test','--','--reporter=default','--reporter=json','--outputFile.json=docs/evidence/stage-3-tests.json'],['run','build'],['run','test:e2e']];
const results=[];let log='';
for(const args of steps){
  const start=new Date().toISOString();
  const result=spawnSync(process.execPath,[npm,...args],{encoding:'utf8',env:process.env,windowsHide:true,maxBuffer:8*1024*1024});
  const output=((result.stdout??'')+(result.stderr??'')).replaceAll(root,'<workspace>').replaceAll(root.replaceAll('\\','/'),'<workspace>');
  log+=`\n$ npm ${args.join(' ')}\n${output}`;
  results.push({command:'npm '+args.join(' '),startedAt:start,completedAt:new Date().toISOString(),exitCode:result.status,result:result.status===0?'PASS':'FAIL'});
  console.log(JSON.stringify(results.at(-1)));
  if(result.status!==0)break;
}
function files(dir){return readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(join(dir,e.name)):[join(dir,e.name)]);}
function sourceManifest(){
const sources=[...files(join(root,'apps/server/src')),...files(join(root,'apps/web/src')),...files(join(root,'bin')),...files(join(root,'packages/contracts/src')),...files(join(root,'tests')),...files(join(root,'scripts')),...files(join(root,'docs/specifications')),...files(join(root,'docs/stages')),...files(join(root,'examples')), ...['package.json','package-lock.json','tsconfig.json','vitest.config.ts','eslint.config.mjs','.npmrc','.node-version','.gitignore','.npmignore','README.md','apps/server/package.json','apps/server/tsconfig.json','apps/web/README.md','apps/web/package.json','apps/web/tsconfig.json','apps/web/vite.config.ts','apps/web/index.html','playwright.config.ts','packages/contracts/package.json','packages/contracts/tsconfig.json'].map(f=>join(root,f))].filter(f=>!f.endsWith('ACCEPTANCE-CRITERIA.md'));
return sources.map(path=>({path:relative(root,path).replaceAll('\\','/'),sha256:createHash('sha256').update(readFileSync(path)).digest('hex')})).sort((a,b)=>a.path.localeCompare(b.path));
}
const manifest=sourceManifest(),sourcesUnchanged=JSON.stringify(initialManifest)===JSON.stringify(manifest);
const passed=sourcesUnchanged&&results.length===steps.length&&results.every(r=>r.result==='PASS');
const digest=createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
const sqlite=new DatabaseSync(':memory:');const sqliteVersion=sqlite.prepare('SELECT sqlite_version() AS v').get().v;sqlite.close();
const artifacts=files(join(root,'apps/web/dist')).map(path=>({path:relative(root,path).replaceAll('\\','/'),sha256:createHash('sha256').update(readFileSync(path)).digest('hex')}));
const bundleFiles=files(join(root,'apps/web/dist')).filter(path=>/\.(js|css)$/.test(path)).map(path=>({path:relative(root,path).replaceAll('\\','/'),gzipBytes:gzipSync(readFileSync(path)).length}));
const allJavaScriptGzipBytes=bundleFiles.filter(f=>f.path.endsWith('.js')).reduce((total,f)=>total+f.gzipBytes,0);
writeFileSync(join(out,'stage-3-bundle.json'),JSON.stringify({recordedAt:new Date().toISOString(),candidateSha256:digest,files:bundleFiles,allJavaScriptGzipBytes,initialBudgetBytes:350*1024,method:'Sum of every independently gzipped JavaScript chunk is an upper bound on initial JavaScript; includes lazy routes/chart.',result:allJavaScriptGzipBytes<=350*1024?'PASS':'FAIL'},null,2)+'\n');
if(allJavaScriptGzipBytes>350*1024)throw new Error('Browser JavaScript budget exceeded.');
const report={artifacts,recordedAt:new Date().toISOString(),candidateSha256:digest,sourcesUnchanged,digestScope:'File manifest below: public source, tests, scripts, configuration, specifications and stages. Generated build outputs, evidence, report and acceptance ledger excluded to avoid circular references.',platform:{os:platform(),release:release(),arch:arch(),node:process.version,sqlite:sqliteVersion},results,files:manifest};
writeFileSync(join(out,'stage-3-verification.log'),log);writeFileSync(join(out,'stage-3-verification.json'),JSON.stringify(report,null,2)+'\n');
if(passed)for(const file of ['stage-3-benchmark.json','stage-3-query-plans.json']){
  const evidence=JSON.parse(readFileSync(join(out,file),'utf8')),testRun=results.find(r=>r.command.startsWith('npm test'));
  const time=evidence.startedAt??evidence.recordedAt;
  if(!testRun||time<testRun.startedAt||time>testRun.completedAt)throw new Error('Current verification did not produce fresh evidence.');
  evidence.candidateSha256=digest;writeFileSync(join(out,file),JSON.stringify(evidence,null,2)+'\n');
}
console.log(JSON.stringify({candidateSha256:digest,sourcesUnchanged,result:passed?'PASS':'FAIL'}));
if(!passed)process.exitCode=1;
