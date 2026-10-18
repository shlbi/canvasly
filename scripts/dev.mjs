import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import handler from '../api/index.js';
const root = resolve('public');
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.mjs': 'text/javascript', '.svg': 'image/svg+xml' };
createServer(async (req, res) => {
  if (req.url.startsWith('/api/index')) return handler(req, res);
  try {
    const name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const path = resolve(root, `.${name === '/' ? '/index.html' : name}`);
    if (!path.startsWith(root + sep)) throw new Error();
    res.setHeader('Content-Type', mime[extname(path)] || 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(await readFile(path));
  } catch { res.writeHead(404); res.end('Not found'); }
}).listen(Number(process.env.PORT || 3000), '0.0.0.0', () => console.log(`Canvasly: http://localhost:${process.env.PORT || 3000} (demo works without keys)`));
