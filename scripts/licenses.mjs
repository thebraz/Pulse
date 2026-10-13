import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256 } from './release-identity.mjs';
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
const rows = Object.entries(lock.packages).filter(([path, value]) => path.startsWith('node_modules/') && !value.dev && !value.link);
if (rows.some(([, value]) => !['MIT', 'ISC', 'BSD-3-Clause'].includes(value.license))) throw new Error('DEPENDENCY_LICENSE_REVIEW_REQUIRED');
let document = '# Third-party notices\n\nPulse is licensed under MIT. The following locked packages support the server or bundled browser application. Development-only dependencies are recorded separately in package-lock.json. Original license texts follow.\n\n| Package | Version | License |\n| --- | --- | --- |\n';
for (const [path, value] of rows) document += `| ${path.replace(/^node_modules\//, '')} | ${value.version} | ${value.license ?? 'SEE LICENSE BELOW'} |\n`;
for (const [path, value] of rows) {
    const names = (await readdir(path)).filter(name => /^(license|copying|notice)(\.|$)/i.test(name));
    if (!names.length) {
        const readme = (await readdir(path)).find(name => /^readme/i.test(name));
        const text = readme ? await readFile(join(path, readme), 'utf8') : '';
        const license = text.match(/(?:^|\n)#+ License\s*\n([\s\S]*)$/i)?.[1]?.trim();
        if (!license) throw new Error('DEPENDENCY_LICENSE_TEXT_MISSING: ' + path);
        document += `\n## ${path.replace(/^node_modules\//, '')} ${value.version}\n\nUpstream package license declaration: ${value.license}. The package supplies this notice in its README:\n\n${license}\n`;
    }
    for (const name of names) document += `\n## ${path.replace(/^node_modules\//, '')} ${value.version}: ${name}\n\n\`\`\`text\n${(await readFile(join(path, name), 'utf8')).trim()}\n\`\`\`\n`;
}
await writeFile('THIRD-PARTY-NOTICES.md', document);
await writeFile('docs/evidence/stage-4-licenses.json', JSON.stringify({ recordedAt: new Date().toISOString(), result: 'PASS', lockSha256: sha256(await readFile('package-lock.json')), noticesSha256: sha256(await readFile('THIRD-PARTY-NOTICES.md')), packages: rows.map(([path, value]) => ({ path, version: value.version, license: value.license })), scope: 'Locked server and bundled browser dependency declarations and original distributed license texts; MIT, ISC and BSD-3-Clause notices included.' }, null, 2) + '\n');
console.log(JSON.stringify({ packages: rows.length, result: 'PASS' }));
