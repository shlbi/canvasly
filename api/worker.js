import handler from './workspace.js';
export default function worker(req,res){req.url='/api/workspace?op=worker/cron';return handler(req,res);}
