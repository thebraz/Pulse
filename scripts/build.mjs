import {existsSync,mkdirSync,readdirSync,unlinkSync,readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join,relative} from 'node:path';
import {spawnSync} from 'node:child_process';

function sources(directory){return readdirSync(directory,{withFileTypes:true}).flatMap(e=>e.isDirectory()?sources(join(directory,e.name)):[join(directory,e.name)]).filter(f=>/\.tsx?$/.test(f)&&!f.endsWith('.d.ts'));}
const cacheDirectory=join('node_modules','.cache','pulse');mkdirSync(cacheDirectory,{recursive:true});
for(const [name,directory] of [['contracts','packages/contracts'],['server','apps/server']]){
    const cache=join(cacheDirectory,name+'.tsbuildinfo'),sourceRoot=join(directory,'src');
    // TypeScript's incremental cache alone can skip a missing generated file.
    const missing=sources(sourceRoot).some(file=>['.js','.js.map','.d.ts'].some(extension=>!existsSync(join(directory,'dist',relative(sourceRoot,file).replace(/\.ts$/,extension)))));
    if(missing&&existsSync(cache))unlinkSync(cache);
    const result=spawnSync(process.execPath,['node_modules/typescript/bin/tsc','-p',directory,'--incremental','--tsBuildInfoFile',cache],{stdio:'inherit',windowsHide:true});
    if(result.status!==0){process.exitCode=1;break;}
}
if(!process.exitCode&&existsSync('apps/web/src/main.tsx')){
    const inputs=[...sources('apps/web/src'),'apps/web/src/styles.css','apps/web/index.html','apps/web/vite.config.ts','apps/web/tsconfig.json','apps/web/package.json','package-lock.json','packages/contracts/src/index.ts','scripts/build.mjs'];
    const digest=createHash('sha256').update(inputs.map(f=>readFileSync(f)).join('\n')).digest('hex'),cache=join(cacheDirectory,'web.json');
    let previous=null;try{previous=JSON.parse(readFileSync(cache,'utf8'));}catch{/* First build has no cache. */}
    if(previous?.digest!==digest||!previous.files.every(f=>existsSync(f))){
        for(const args of [['node_modules/typescript/bin/tsc','-p','apps/web'],['node_modules/vite/bin/vite.js','build','apps/web']]){const result=spawnSync(process.execPath,args,{stdio:'inherit',windowsHide:true,env:{...process.env,NODE_ENV:'production'}});if(result.status!==0){process.exitCode=1;break;}}
        if(!process.exitCode){const files=readdirSync('apps/web/dist/assets').map(f=>join('apps/web/dist/assets',f));writeFileSync(cache,JSON.stringify({digest,files:['apps/web/dist/index.html',...files]}));}
    }
}
