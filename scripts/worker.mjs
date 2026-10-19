// Optional scheduled-worker alternative. Run on an always-on server you control.
// Requires approved hosted ChatGPT plan usage. Never makes a paid API fallback.
const url=new URL(process.env.APP_URL||'');if(url.protocol!=='https:')throw new Error('Set an HTTPS APP_URL.');if(!process.env.CRON_SECRET)throw new Error('Set CRON_SECRET.');
let stopped=false;process.on('SIGINT',()=>stopped=true);
while(!stopped){try{const r=await fetch(new URL('/api/worker',url),{headers:{Authorization:`Bearer ${process.env.CRON_SECRET}`},redirect:'error',signal:AbortSignal.timeout(55000)});if(!r.ok)console.error(`Worker endpoint returned ${r.status}.`);}catch{console.error('Worker connection failed; retrying without replaying completed actions.');}await new Promise(r=>setTimeout(r,3000));}
