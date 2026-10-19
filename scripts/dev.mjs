import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import handler from '../api/workspace.js';
import {initializeLocal,WorkspaceStore,localMode} from '../lib/workspace/store.mjs';
import {workerTick} from '../lib/workspace/worker.mjs';
await initializeLocal();
const root=resolve('public'),mime={'.html':'text/html; charset=utf-8','.css':'text/css','.mjs':'text/javascript','.svg':'image/svg+xml'};
const port=Number(process.env.PORT||3000),store=new WorkspaceStore();let busy=false;
createServer(async(req,res)=>{
  // Prevent DNS-rebinding and accidental LAN exposure of local credentials.
  if(req.headers.host!==`127.0.0.1:${port}`){res.writeHead(403);return res.end(`Use http://127.0.0.1:${port}`);}
  const pathName=new URL(req.url,'http://127.0.0.1').pathname;
  if(pathName.startsWith('/api/')||['/auth/callback','/canvas/callback'].includes(pathName))return handler(req,res);
  try{const name=decodeURIComponent(pathName),path=resolve(root,`.${name==='/'?'/index.html':name}`);if(!path.startsWith(root+sep))throw new Error();res.setHeader('Content-Type',mime[extname(path)]||'application/octet-stream');res.setHeader('X-Content-Type-Options','nosniff');res.end(await readFile(path));}catch{res.writeHead(404);res.end('Not found');}
}).listen(port,'127.0.0.1',()=>console.log(`Canvasly: http://127.0.0.1:${port}\nLocal worker is running. Close the browser without stopping the server to continue queued work.`));
if(localMode())setInterval(async()=>{if(busy)return;busy=true;try{await workerTick(store);}catch{console.error('Worker paused: check storage/configuration. No credentials were logged.');}finally{busy=false;}},1500).unref();
