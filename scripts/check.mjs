import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
async function check(dir) {
  for (const f of await readdir(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', '.vercel'].includes(f.name)) continue;
    const path = `${dir}/${f.name}`;
    if (f.isDirectory()) await check(path);
    else if (/\.(mjs|js)$/.test(path)) {
      const r = spawnSync(process.execPath, ['--check', path], { stdio: 'inherit' });
      if (r.status) process.exit(r.status);
    }
  }
}
await check('.');
JSON.parse(await readFile('vercel.json', 'utf8'));
console.log('Canvasly: JavaScript syntax and Vercel configuration valid. Static assets are in public/.');
