import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { stageSource } from './source-archive.mjs';
import { files, root } from './package.mjs';
import { releaseIdentity, sameReleaseIdentity } from './release-identity.mjs';
const report={startedAt:new Date().toISOString(),platform:process.platform,node:process.version,result:'FAIL',steps:[]};
report.releaseIdentity = await releaseIdentity(root);
try {
    const cleanRoot=await mkdtemp(join(tmpdir(),'pulse-source-install-'));
    const {stage,digest}=await stageSource(root,cleanRoot);report.sourceDigest=digest;
    const npm=process.env.npm_execpath;if(!npm)throw new Error('USE_NPM_RUN');
    for(const args of [['ci','--ignore-scripts','--no-audit','--no-fund'],['run','build']]) {
        const result=spawnSync(process.execPath,[npm,...args],{cwd:stage,encoding:'utf8',windowsHide:true,timeout:180000,maxBuffer:4*1024*1024});
        report.steps.push({command:'npm '+args.join(' '),exitCode:result.status});
        if(result.status!==0)throw new Error('SOURCE_CLEAN_INSTALL_OR_BUILD_FAILED');
    }
    const hashes=[], differences=[];
    for(const directory of ['apps/server/dist','packages/contracts/dist','apps/web/dist'])for(const path of await files(join(stage,directory))) {
        if(path.endsWith('.map'))continue;
        const name=relative(stage,path),bytes=await readFile(path);
        let original;try{original=await readFile(join(root,name));}catch{original=null;}
        if(!original?.equals(bytes)) {
            if(!name.replaceAll('\\','/').startsWith('apps/web/dist/'))throw new Error('SERVER_OR_CONTRACT_BUILD_DIFFERS');
            differences.push({path:name.replaceAll('\\','/'),cleanBytes:bytes.length,localBytes:original?.length??null});
        }
        hashes.push({path:name.replaceAll('\\','/'),sha256:createHash('sha256').update(bytes).digest('hex')});
    }
    for(const path of await files(join(root,'apps/web/dist'))) {
        const name=relative(root,path);
        if(!hashes.some(h=>h.path===name.replaceAll('\\','/'))&&!path.endsWith('.map'))differences.push({path:name.replaceAll('\\','/'),cleanBytes:null,localBytes:(await readFile(path)).length});
    }
    report.compiledFiles=hashes;report.frontendByteReproducibility=differences.length?'FAIL':'PASS';report.frontendDifferences=differences;
    // Validate the clean build's own browser assets and runtime rather than assuming byte equivalence.
    const browser=spawnSync(process.execPath,[npm,'run','test:e2e'],{cwd:stage,encoding:'utf8',env:{...process.env,TEST_EVIDENCE_PREFIX:'stage-4-clean-source'},windowsHide:true,timeout:180000,maxBuffer:4*1024*1024});
    report.steps.push({command:'npm run test:e2e (clean source)',exitCode:browser.status});
    if(browser.status!==0)throw new Error('CLEAN_SOURCE_BROWSER_FAILED');
    const result=JSON.parse(await readFile(join(stage,'docs/evidence/stage-4-clean-source-browser.json'),'utf8'));
    report.browser={passed:result.stats.expected,failed:result.stats.unexpected,skipped:result.stats.skipped,flaky:result.stats.flaky};
    if(result.stats.unexpected||result.stats.flaky||result.stats.expected!==8)throw new Error('CLEAN_SOURCE_BROWSER_INCOMPLETE');
    if(differences.length)throw new Error('FRONTEND_BUILD_DIFFERS');
    report.cleanReleaseIdentity = await releaseIdentity(stage);
    if (!sameReleaseIdentity(report.cleanReleaseIdentity, report.releaseIdentity) || !sameReleaseIdentity(await releaseIdentity(root), report.releaseIdentity)) throw new Error('CLEAN_SOURCE_IDENTITY_CHANGED');
    report.candidateUnchangedDuringRun = true;
    report.result='PASS';
} catch(error) {report.failure=/^[A-Z_]+$/.test(error.message)?error.message:'SOURCE_REHEARSAL_FAILED';process.exitCode=1;}
report.completedAt=new Date().toISOString();await writeFile('docs/evidence/stage-4-source-install.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({result:report.result,steps:report.steps}));
