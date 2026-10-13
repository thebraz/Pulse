import { mkdir, mkdtemp, readdir, readFile, writeFile, cp } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { root, files } from './package.mjs';

const paths = ['.github', '.node-version', 'apps', 'bin', 'docs', 'examples', 'packages', 'scripts', 'tests', 'package.json', 'package-lock.json', 'tsconfig.json', 'vitest.config.ts', 'playwright.config.ts', 'eslint.config.mjs', '.gitignore', '.npmignore', 'README.md', 'LICENSE', 'THIRD-PARTY-NOTICES.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md'];
const excluded = /(^|\/)(?:node_modules|dist|\.private|\.git|AGENTS\.md|\.env(?:\..*)?|data|secrets|backups|logs|coverage|test-results|playwright-report|release)(\/|$)|\.(?:sqlite(?:-(?:wal|shm))?|tgz|zip|tsbuildinfo|log)$/i;
const sanitize = value => {
    if (typeof value === 'string') return value.replaceAll(root.replaceAll('\\', '/').replace(/\/$/, ''), '<workspace>').replaceAll(root.replace(/[/\\]$/, ''), '<workspace>').replaceAll(/C:[/\\]Users[/\\][^/\\\s"<>]+[/\\](?:AppData[/\\]Local[/\\]Temp[/\\])?[^\s"<>]*/gi, '<local-path>');
    if (Array.isArray(value)) return value.map(sanitize);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,sanitize(v)]));
    return value;
};
export async function stageSource(sourceRoot = root, output = join(root, 'release')) {
    await mkdir(output, { recursive: true });
    const stage = await mkdtemp(join(output, 'source-'));
    const available = new Set(await readdir(sourceRoot));
    for (const path of paths.filter(p=>available.has(p))) await cp(join(sourceRoot,path),join(stage,path),{recursive:true,filter:async path=>{
        const name=relative(sourceRoot,path).replaceAll('\\','/');
        if(excluded.test(name))return false;
        const {lstat}=await import('node:fs/promises');
        if((await lstat(path)).isSymbolicLink())throw new Error('SOURCE_SYMLINK_REJECTED');
        return true;
    }});
    const entries=[];
    for(const path of (await files(stage)).sort()) {
        const name=relative(stage,path).replaceAll('\\','/');
        if(name.endsWith('.md'))await writeFile(path,(await readFile(path,'utf8')).replace(/\[(?:command output|sanitized command log)\]\(([^)]+)\.log\)/g,'[command result summary]($1.json)'));
        if(/\.(?:json|log)$/.test(name)&&name.startsWith('docs/evidence/')) {
            const original=await readFile(path,'utf8');
            await writeFile(path,name.endsWith('.json')?JSON.stringify(sanitize(JSON.parse(original)),null,2)+'\n':sanitize(original));
        }
        const bytes=await readFile(path), text=bytes.toString('utf8');
        if(/C:[/\\]+Users[/\\]+|\/Users\/[^/]+\//i.test(text))throw new Error('PERSONAL_PATH_IN_SOURCE_'+name);
        if(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)&&name!=='tests/fixtures/localhost-key.pem')throw new Error('PRIVATE_KEY_IN_SOURCE_'+name);
        if(/(?:ghp_[A-Za-z0-9]{36}|npm_[A-Za-z0-9]{36})/.test(text))throw new Error('CREDENTIAL_PATTERN_IN_SOURCE_'+name);
        if(excluded.test(name))throw new Error('FORBIDDEN_SOURCE_ENTRY');
        entries.push({path:name,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
    }
    const digest=createHash('sha256').update(JSON.stringify(entries)).digest('hex');
    return {stage,entries,digest};
}
export async function archiveSource() {
    const {stage,entries,digest}=await stageSource();
    const {version}=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
    const archive=join(root,'release',`pulse-source-${version}.tgz`);
    const result=spawnSync('tar',['-czf',archive,'-C',stage,'.'],{windowsHide:true,encoding:'utf8',timeout:120000});
    if(result.status!==0)throw new Error('SOURCE_TAR_FAILED');
    const report={recordedAt:new Date().toISOString(),version,sourceDigest:digest,sha256:createHash('sha256').update(await readFile(archive)).digest('hex'),files:entries};
    await writeFile(join(root,'release','source-manifest.json'),JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify({sourceDigest:digest,sha256:report.sha256,files:entries.length}));
}
if(process.argv[1]?.endsWith('source-archive.mjs'))await archiveSource();
