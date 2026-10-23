import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { handler } from '../lib/app/api.mjs';

const root = resolve('public'), port = Number(process.env.PORT || 3000);
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.mjs': 'text/javascript', '.svg': 'image/svg+xml' };

/** Serve the real application locally with host checking and the exact production API router. */
async function request(req, res) {
  if (req.headers.host !== `127.0.0.1:${port}`) { res.writeHead(403); return res.end(`Use http://127.0.0.1:${port}`); }
  const name = new URL(req.url, 'http://127.0.0.1').pathname;
  if (name.startsWith('/api/') || name.startsWith('/.well-known/') || ['/mcp','/auth/callback','/canvas/callback'].includes(name) || (name.startsWith('/oauth/') && name !== '/oauth/consent')) return handler(req, res);
  try {
    const path = resolve(root, `.${name === '/' || name === '/oauth/consent' ? '/index.html' : decodeURIComponent(name)}`);
    if (!path.startsWith(root + sep)) throw new Error('Invalid path');
    res.setHeader('Content-Type', mime[extname(path)] || 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.end(await readFile(path));
  } catch { res.writeHead(404); res.end('Not found'); }
}

createServer(request).listen(port, '127.0.0.1', /* Announce only the web server, not an unstarted worker. */ () => console.log(`Canvasly: http://127.0.0.1:${port}\nThe public preview needs no keys. Real accounts use Supabase; run the separate worker for unattended tasks.`));
