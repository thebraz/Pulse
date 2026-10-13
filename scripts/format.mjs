import ts from 'typescript';
import { readdirSync,readFileSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
function files(dir){return readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(join(dir,e.name)):[join(dir,e.name)]);}
const printer=ts.createPrinter({newLine:ts.NewLineKind.LineFeed});
for(const file of [...files('apps/server/src'),...files('apps/web/src'),...files('packages/contracts/src'),...files('tests')].filter(f=>/\.tsx?$/.test(f))){const source=ts.createSourceFile(file,readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);function visit(node){if(ts.isBlock(node)||ts.isObjectLiteralExpression(node))ts.setEmitFlags(node,ts.EmitFlags.MultiLine);ts.forEachChild(node,visit);}visit(source);writeFileSync(file,printer.printFile(source));}
