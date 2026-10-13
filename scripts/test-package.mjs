import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, readdir, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, platform, release, arch } from 'node:os';
import { fork, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from '@playwright/test';
import { files } from './package.mjs';
import { acquireLock } from '../apps/server/dist/runtime/lock.js';
import { releaseIdentity, sameReleaseIdentity } from './release-identity.mjs';

const workspace = process.cwd(), manifest = JSON.parse(await readFile('release/package-manifest.json', 'utf8'));
const archive = join(workspace, 'release', `${manifest.name}-${manifest.version}.tgz`);
assert.equal(createHash('sha256').update(await readFile(archive)).digest('hex'), manifest.sha256);
const identity = await releaseIdentity(workspace);
assert.ok(sameReleaseIdentity(manifest.releaseIdentity, identity), 'PACKAGE_MANIFEST_IDENTITY_MISMATCH');
let dir;
for(let attempt=0;;attempt++) {
    dir=await mkdtemp(join(tmpdir(),'pulse-installed-'));
    try {
        // Select only a new empty fixture; never bypass a persisted directory's ownership lock.
        const lock=await acquireLock(join(dir,'data'));await lock.release();break;
    } catch(error) { if(error.code!=='DATA_DIRECTORY_LOCKED'||attempt>=7)throw error; }
}
const data = join(dir, 'data'), secrets = join(dir, 'secrets'), cwd = join(dir, 'working-directory');
await Promise.all([data, secrets, cwd].map(path => mkdir(path,{recursive:true})));
await writeFile(join(dir,'package.json'),JSON.stringify({name:'pulse-clean-install',version:'1.0.0',private:true,type:'module'}));
const results = [], startedAt = new Date().toISOString();
const step = name => { results.push({ name, result: 'PASS' }); console.log('PASS ' + name); };
const wait = ms => new Promise(r=>setTimeout(r,ms));
async function until(fn, predicate, timeout=15000) { const deadline=Date.now()+timeout; for (;;) { const value=await fn(); if(predicate(value)) return value; if(Date.now()>deadline) throw new Error('CONDITION_DEADLINE'); await wait(25); } }
async function listen(server) { await new Promise(r=>server.listen(0,'127.0.0.1',r)); return server.address().port; }
let failure=false, receiptError=null, receiverUnavailable=false;
const key = randomBytes(32).toString('base64url'), receipts=[];
const target = createServer((_req,res)=>{res.writeHead(failure?500:200);res.end('Controlled release fixture');}), targetPort=await listen(target);
const receiver = createServer(async(req,res)=>{
    try { let body=''; for await (const chunk of req) body+=String(chunk); const payload=JSON.parse(body); assert.equal(req.headers['x-pulse-event-id'],payload.eventId); assert.equal(req.headers['x-pulse-signature'],'v1='+createHmac('sha256',Buffer.from(key,'base64url')).update(req.headers['x-pulse-timestamp']+'.'+body).digest('hex')); receipts.push(payload); res.writeHead(receiverUnavailable?503:204,receiverUnavailable?{'retry-after':'30'}:{}); res.end(); }
    catch(error) { receiptError=error.message; res.writeHead(500); res.end(); }
}), receiverPort=await listen(receiver), placeholder=createServer(), port=await listen(placeholder);
await new Promise(r=>placeholder.close(r));
const origin=`http://127.0.0.1:${port}`;
await writeFile(join(secrets,'ops.url'),`http://127.0.0.1:${receiverPort}/events?key=FAKE_RELEASE_CANARY`,{mode:0o600});
await writeFile(join(secrets,'ops.key'),key,{mode:0o600});
const env={...process.env}; for(const name of Object.keys(env)) if(name.startsWith('PULSE_')||['NODE_PATH','NODE_OPTIONS'].includes(name)) delete env[name];
Object.assign(env,{PULSE_DATA_DIR:data,PULSE_SECRETS_DIR:secrets,PULSE_PORT:String(port),PULSE_PUBLIC_ORIGIN:origin,PULSE_EGRESS_POLICY:'allow-private',PULSE_ALLOWED_PRIVATE_CIDRS:'127.0.0.1/32'});
let child=null, exited=null, log='', browser=null;
const npm=process.env.npm_execpath;
const install=spawnSync(process.execPath,[npm,'install','--global','--prefix',dir,'--ignore-scripts','--no-audit','--no-fund',archive],{cwd:dir,env,encoding:'utf8',windowsHide:true,timeout:180000});
const installed=join(dir,...(platform()==='win32'?[]:['lib']),'node_modules',manifest.name), cli=join(installed,'bin/pulse.mjs');
async function start(databaseDirectory=data, workingDirectory=cwd) {
    child=fork(cli,['start'],{cwd:workingDirectory,env:{...env,PULSE_DATA_DIR:databaseDirectory},execArgv:[],silent:true,windowsHide:true});
    exited=once(child,'exit'); child.stdout.on('data',b=>{log+=b.toString();}); child.stderr.on('data',b=>{log+=b.toString();});
    await until(async()=>{if(child.exitCode!==null) throw new Error('INSTALLED_PROCESS_EXIT_'+child.exitCode); try{return (await fetch(origin+'/health/ready')).ok;}catch{return false;}},Boolean);
}
async function stop() { if(child?.exitCode===null&&child.signalCode===null) child.send('shutdown'); if(exited){const result=await Promise.race([exited,wait(15000).then(()=>{throw new Error('SHUTDOWN_DEADLINE');})]);assert.equal(result[0],0);}child=null;exited=null; }
async function request(path,method='GET',body,headers={}) { const response=await fetch(origin+path,{method,headers:{origin,...(body===undefined?{}:{'content-type':'application/json'}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})}); assert.ok(response.ok,'API_STATUS_'+response.status); return response.status===204?null:response.json(); }
async function check(id) { const reserved=await request(`/api/v1/monitors/${id}/checks`,'POST',{}); return until(async()=> (await request('/api/v1/executions/'+reserved.data.id)).data,c=>c.lifecycle==='COMPLETED'); }
function snapshot(path) { const db=new DatabaseSync(path,{readOnly:true}); try { assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok'); assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]); return Object.fromEntries(['monitors','checks','incidents','notification_deliveries','schema_migrations'].map(table=>[table,db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all()])); } finally {db.close();} }
try {
    assert.equal(install.status,0,'CLEAN_INSTALL_FAILED');
    const shim=join(dir,...(platform()==='win32'?[]:['bin']),platform()==='win32'?'pulse.cmd':'pulse');
    let executable;
    if(platform()==='win32') {
        assert.ok((await readFile(shim,'utf8')).includes('pulse.mjs'));
        // npm exec can resolve an unrelated global Pulse already on PATH.
        const conflictingBin=join(dir,'conflicting-bin'); await mkdir(conflictingBin);
        await writeFile(join(conflictingBin,'pulse.cmd'),'@echo off\r\necho WRONG_GLOBAL_EXECUTABLE\r\nexit /b 37\r\n');
        const pathKey=Object.keys(env).find(key=>key.toUpperCase()==='PATH')??'PATH';
        const executableEnv={...env,[pathKey]:conflictingBin+';'+(env[pathKey]??'')};
        executable=spawnSync(process.env.ComSpec??'cmd.exe',['/d','/s','/c',`""${shim}" version"`],{cwd,env:executableEnv,encoding:'utf8',windowsHide:true,windowsVerbatimArguments:true,timeout:15000});
    }
    else {
        assert.equal(await realpath(shim),await realpath(cli),'INSTALLED_LINK_TARGET_MISMATCH');
        assert.ok((await stat(shim)).mode&0o111,'INSTALLED_LINK_NOT_EXECUTABLE');
        executable=spawnSync(shim,['version'],{cwd,env,encoding:'utf8',timeout:15000});
    }
    assert.equal(executable.status,0,'INSTALLED_EXECUTABLE_FAILED');assert.equal(executable.stdout,`Pulse ${manifest.version}\n`);
    assert.equal((await readFile(join(installed,'package.json'),'utf8')).includes('@pulse/contracts'),false);
    step('Clean archive installation without workspace dependencies');
    const runtimeFiles=await files(installed); assert.ok(runtimeFiles.length>10);
    for(const path of runtimeFiles.filter(p=>/\.(?:js|json|md|html|css)$/.test(p))) {const content=await readFile(path,'utf8');assert.ok(!content.includes('FAKE_RELEASE_CANARY')&&!content.includes(workspace)&&!content.includes('PULSE-DEVELOPMENT-RULES'));}
    step('Exact archive contents and credential/path exclusions');
    await start(); step('Installed CLI startup and database initialization');
    assert.equal((await fetch(origin+'/monitors/new')).status,200);
    const html=await (await fetch(origin)).text(),asset=html.match(/src="([^"]+\.js)"/)[1];assert.equal((await fetch(origin+asset)).status,200);assert.equal((await fetch(origin+'/api/v1/missing')).status,404);
    step('Built dashboard, static assets and deep links on the API origin');
    browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(origin);await page.getByRole('link',{name:'＋ Create monitor'}).click();await page.getByLabel('Monitor name',{exact:true}).fill('Release fixture');await page.getByLabel('Target URL').fill(`http://127.0.0.1:${targetPort}/health`);await page.getByLabel('Interval (ms)',{exact:true}).fill('15000');await page.getByLabel('Failure threshold',{exact:true}).fill('2');await page.getByLabel('Recovery threshold',{exact:true}).fill('2');await page.getByRole('button',{name:'Create monitor',exact:true}).click();await page.waitForURL(/\/monitors\/[0-9a-f-]+$/);const id=page.url().split('/').at(-1);
    await until(async()=> (await request('/api/v1/monitors/'+id)).data,m=>m.status.state==='UP');step('Create monitor in installed dashboard and observe real HTTP success');
    const destination=await request('/api/v1/notification-destinations','POST',{name:'Release receiver',urlSecretRef:'ops',signingSecretRef:'ops',enabled:true});await request('/api/v1/notification-destinations/'+destination.data.id+'/test','POST',{});await until(()=>receipts,r=>r.some(e=>e.type==='notification.test'));assert.equal(receiptError,null);step('Provisioned signed test webhook received by actual receiver');
    failure=true;await check(id);await check(id);const outage=(await request('/api/v1/incidents?status=OPEN')).data;assert.equal(outage.length,1);await until(()=>receipts,r=>r.some(e=>e.type==='incident.opened'));step('Confirmed incident and signed incident-opened receipt');
    failure=false;await check(id);await check(id);const incident=(await request('/api/v1/incidents/'+outage[0].id)).data;assert.equal(incident.status,'RESOLVED');await until(()=>receipts,r=>r.some(e=>e.type==='incident.resolved'));step('Confirmed recovery of the same incident and recovery receipt');
    const metrics=(await request(`/api/v1/monitors/${id}/metrics?window=24h`)).data;assert.ok(metrics.successfulCount>=3&&metrics.failedCount>=2);assert.ok(metrics.latency.count>=3);step('Historical metrics contain actual successful and failed observations');
    await page.goto(origin);await page.getByRole('link',{name:'Release fixture',exact:true}).waitFor({timeout:10000});if(process.env.UPDATE_RELEASE_SCREENSHOT==='1')await page.screenshot({path:join(workspace,'docs/images/dashboard.png'),fullPage:true});assert.deepEqual(errors,[]);await browser.close();browser=null;step('Installed real-browser interface without page errors');
    const doctor=spawnSync(process.execPath,[cli,'doctor'],{cwd,env,encoding:'utf8',windowsHide:true,timeout:10000});assert.equal(doctor.status,0);assert.ok(doctor.stdout.includes('Backend: ready')&&doctor.stdout.includes('checksums verified'));step('Installed diagnostic, help and version commands');
    for(const command of ['help','version']) assert.equal(spawnSync(process.execPath,[cli,command],{cwd,env,windowsHide:true}).status,0);
    receiverUnavailable=true;
    const pendingDestination=(await request('/api/v1/notification-destinations','POST',{name:'Restore receiver',urlSecretRef:'ops',signingSecretRef:'ops',enabled:true})).data;
    await request('/api/v1/notification-destinations/'+pendingDestination.id+'/test','POST',{});
    const pending=await until(async()=>(await request('/api/v1/notification-deliveries?destinationId='+pendingDestination.id)).data.find(d=>d.state==='PENDING'&&d.attemptCount===1),Boolean);
    step('Real failed receipt persists a pending retry before backup');
    await stop();step('Graceful installed process shutdown');
    const before=snapshot(join(data,'pulse.sqlite')),backup=join(dir,'backup.sqlite');await copyFile(join(data,'pulse.sqlite'),backup);const hash=createHash('sha256').update(await readFile(backup)).digest('hex');assert.deepEqual(snapshot(backup),before);step('Stopped SQLite backup, checksum, integrity and foreign keys');
    const restored=join(dir,'restored');await mkdir(restored);await copyFile(backup,join(restored,'pulse.sqlite'));assert.equal(createHash('sha256').update(await readFile(join(restored,'pulse.sqlite'))).digest('hex'),hash);assert.deepEqual(snapshot(join(restored,'pulse.sqlite')),before);receiverUnavailable=false;await start(restored);assert.equal((await request('/api/v1/monitors/'+id)).data.id,id);assert.equal((await request('/api/v1/incidents/'+outage[0].id)).data.status,'RESOLVED');
    await until(async()=>(await request('/api/v1/notification-deliveries?destinationId='+pendingDestination.id)).data.find(d=>d.id===pending.id),d=>d?.state==='SUCCEEDED',45000);
    assert.ok(receipts.filter(e=>e.eventId===pending.eventId).length>=2);assert.equal(receiptError,null);
    await stop();step('Isolated restore preserves IDs and delivers the pending signed retry');
    const anotherCwd=join(dir,'another-directory');await mkdir(anotherCwd);await start(data,anotherCwd);assert.equal((await request('/api/v1/monitors/'+id)).data.id,id);assert.ok((await request(`/api/v1/monitors/${id}/checks`)).data.length>=before.checks.length);await stop();step('Restart from another directory preserves configured data');
    assert.ok(!log.includes('FAKE_RELEASE_CANARY')&&!log.includes(key));assert.ok(!(await readdir(installed)).includes('data'));step('Installed package remains free of runtime data and secret logs');
} catch(error) {
    await mkdir('.private',{recursive:true});
    await writeFile('.private/package-failure.json',JSON.stringify({message:error.message,installStatus:install.status,installError:install.stderr,processLog:log},null,2).replaceAll(key,'<redacted>').replaceAll('FAKE_RELEASE_CANARY','<redacted>')+'\n');
    results.push({name:'Package rehearsal stopped',code:/^[A-Z_0-9]+$/.test(error.code??'')?error.code:'PACKAGE_REHEARSAL_FAILED',result:'FAIL'});process.exitCode=1;
}
finally {
    await browser?.close();if(child?.exitCode===null){try{await stop();}catch{child?.kill();}}
    target.closeAllConnections();receiver.closeAllConnections();await Promise.all([new Promise(r=>target.close(r)),new Promise(r=>receiver.close(r))]);
    const unchanged = sameReleaseIdentity(await releaseIdentity(workspace), identity);
    if (!unchanged) { results.push({ name: 'Candidate remained immutable', result: 'FAIL' }); process.exitCode = 1; }
    await mkdir('docs/evidence',{recursive:true});const report={startedAt,completedAt:new Date().toISOString(),candidateSha256:manifest.sha256,releaseIdentity:identity,candidateUnchangedDuringRun:unchanged,platform:{os:platform(),release:release(),arch:arch(),node:process.version},passed:results.filter(r=>r.result==='PASS').length,failed:results.filter(r=>r.result==='FAIL').length,results};await writeFile('docs/evidence/stage-4-package.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({passed:report.passed,failed:report.failed}));
}
