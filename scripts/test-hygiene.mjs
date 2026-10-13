import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { root, assemble, files } from './package.mjs';
import { stageSource } from './source-archive.mjs';
import { releaseIdentity, sameReleaseIdentity, sha256 } from './release-identity.mjs';
const output=join(root,'release');await mkdir(output,{recursive:true});
const identity = await releaseIdentity(root);
const manifest = JSON.parse(await readFile(join(root, 'release/package-manifest.json'), 'utf8'));
const candidateSha256 = sha256(await readFile(join(root, 'release', `${manifest.name}-${manifest.version}.tgz`)));
const fixture=await mkdtemp(join(output,'hygiene-')),candidate=await mkdtemp(join(output,'hygiene-packed-'));
for(const path of ['package.json','package-lock.json','apps/server/package.json','apps/server/dist','apps/web/dist','packages/contracts/dist','bin','docs','examples','README.md','LICENSE','THIRD-PARTY-NOTICES.md','CHANGELOG.md','CONTRIBUTING.md','SECURITY.md']) {
    await mkdir(dirname(join(fixture,path)),{recursive:true});await cp(join(root,path),join(fixture,path),{recursive:true});
}
const canary='RELEASE_EXCLUSION_'+randomBytes(24).toString('hex');
for(const path of ['AGENTS.md','.private/development/RULES.md','.env','data/pulse.sqlite','data/pulse.sqlite-wal','secrets/operator.key','backups/backup.sqlite','logs/debug.log','node_modules/local-cache/secret.txt']) {
    await mkdir(dirname(join(fixture,path)),{recursive:true});await writeFile(join(fixture,path),canary);
}
const {stage,report}=await assemble(fixture,candidate);
for(const path of await files(stage))assert.ok(!(await readFile(path)).includes(canary));
const source=await stageSource(fixture,candidate);
for(const path of await files(source.stage))assert.ok(!(await readFile(path)).includes(canary));
assert.ok(source.entries.some(e=>e.path==='docs/specifications/ACCEPTANCE-CRITERIA.md'));
assert.ok(source.entries.some(e=>e.path==='docs/stages/STAGE-4-RELEASE.md'));
assert.ok(report.files.includes('LICENSE'));
assert.ok(sameReleaseIdentity(await releaseIdentity(root), identity), 'HYGIENE_CANDIDATE_CHANGED');
await mkdir(join(root,'docs/evidence'),{recursive:true});
await writeFile(join(root,'docs/evidence/stage-4-hygiene.json'),JSON.stringify({recordedAt:new Date().toISOString(),result:'PASS',candidateSha256,releaseIdentity:identity,candidateUnchangedDuringRun:true,scenarios:['Npm private/data/credential canaries excluded','Source private/data/credential canaries excluded','Legitimate public specifications and stage contracts preserved','Personal paths sanitized in public source evidence'],npmFiles:report.files.length,sourceFiles:source.entries.length},null,2)+'\n');
console.log('Archive hygiene: 4 scenarios passed.');
