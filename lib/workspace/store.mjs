import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {AppError,seal,unseal,requireValue,digest} from '../security.mjs';
import {defaultProfile} from '../../public/domain.mjs';
export const localMode=()=>!process.env.VERCEL && process.env.CANVASLY_MODE!=='hosted';
export const dataDir=()=>resolve(process.env.CANVASLY_DATA_DIR||'.canvasly');
const keyHash=value=>createHash('sha256').update(value).digest('hex');
const locks=new Map();
async function serial(key,fn) {const prev=locks.get(key)||Promise.resolve();let release;const current=new Promise(r=>release=r);locks.set(key,current);await prev;try{return await fn();}finally{release();if(locks.get(key)===current)locks.delete(key);}}
export async function initializeLocal() {
  if(!localMode())return;
  await mkdir(dataDir(),{recursive:true,mode:0o700});
  const path=resolve(dataDir(),'encryption.key');
  if(!process.env.APP_ENCRYPTION_KEY){try{process.env.APP_ENCRYPTION_KEY=(await readFile(path,'utf8')).trim();}catch(e){if(e.code!=='ENOENT')throw e;const key=randomBytes(32).toString('hex');await writeFile(path,key,{flag:'wx',mode:0o600});process.env.APP_ENCRYPTION_KEY=key;}}
}
async function fileWrite(name,data) {await mkdir(dataDir(),{recursive:true,mode:0o700});const path=resolve(dataDir(),name),tmp=`${path}.${randomUUID()}.tmp`;await writeFile(tmp,JSON.stringify(data),{mode:0o600});await rename(tmp,path);}
export function emptyState(identity={}) {return {profile:defaultProfile(),snapshot:{courses:[],assignments:[],warnings:[]},messages:[],jobs:[],drafts:[],proposals:[],plan:null,connection:null,ai:null,identity,model:null,grant_generation:0,usage:{},created_at:new Date().toISOString()};}
export class WorkspaceStore {
  constructor(fetchImpl=fetch){this.fetch=fetchImpl;}
  async request(path,method='GET',data,prefer='return=representation') {
    const base=requireValue('SUPABASE_URL'),key=requireValue('SUPABASE_SECRET_KEY');const r=await this.fetch(`${base}/rest/v1/canvasly_v2_records${path}`,{method,headers:{apikey:key,...(!key.startsWith('sb_secret_')?{Authorization:`Bearer ${key}`}:{}) ,'Content-Type':'application/json',Prefer:prefer},...(data===undefined?{}:{body:JSON.stringify(data)}),signal:AbortSignal.timeout(12000),redirect:'error'});
    if(!r.ok)throw new AppError('Workspace storage is unavailable. Check the v2 migration and server credentials.',503);return r.status===204?[]:r.json();
  }
  async read(key) {if(localMode()){try{return JSON.parse(await readFile(resolve(dataDir(),`${keyHash(key)}.json`),'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}return (await this.request(`?id=eq.${keyHash(key)}&limit=1`))[0]||null;}
  async create(key,data) {return serial(key,async()=>{const old=await this.read(key);if(old)return old;const row={id:keyHash(key),version:1,data,updated_at:new Date().toISOString()};if(localMode()){await fileWrite(`${keyHash(key)}.json`,row);return row;}const result=await this.request('?on_conflict=id','POST',row,'resolution=ignore-duplicates,return=representation');return result[0]||this.read(key);});}
  async mutate(key,fn) {return serial(key,async()=>{for(let n=0;n<6;n++){const row=await this.read(key);if(!row)throw new AppError('Workspace not found.',404);const draft=structuredClone(row.data);const result=await fn(draft);if(result===false)return row;const next={...row,data:draft,version:row.version+1,updated_at:new Date().toISOString()};if(Buffer.byteLength(JSON.stringify(next))>18000000)throw new AppError('Workspace is full. Remove older conversations or drafts first.',413);if(localMode()){await fileWrite(`${keyHash(key)}.json`,next);return next;}const changed=await this.request(`?id=eq.${row.id}&version=eq.${row.version}`,'PATCH',{data:draft,version:next.version,updated_at:next.updated_at});if(changed.length)return changed[0];}throw new AppError('Another request changed this workspace. Try again.',409);});}
  async accounts(){if(localMode()){const index=await this.read('_index');return index?.data.keys||[];}const rows=await this.request('?id=eq.'+keyHash('_index')+'&limit=1');return rows[0]?.data.keys||[];}
  async register(key,identity){await this.create(key,emptyState(identity));await this.create('_index',{keys:[]});await this.mutate('_index',d=>{if(!d.keys.includes(key)){if(d.keys.length>=1000)throw new AppError('Private beta capacity reached.',503);d.keys.push(key);}});return this.read(key);}
}
export async function stableHost(store){await store.create('_host',{id:`urn:uuid:${randomUUID()}`});return (await store.read('_host')).data.id;}
export const hideSecret=(value,purpose)=>seal(value,purpose);
export const readSecret=(value,purpose)=>unseal(value,purpose);
export function accountKey(identity){return keyHash(JSON.stringify([identity.iss,identity.client_id,identity.sub]));}
export function safeState(row) {const d=row.data;return {version:row.version,profile_revision:d.profile_revision||0,profile:d.profile,snapshot:d.snapshot,messages:d.messages.slice(-100),jobs:d.jobs.map(({input,lease,...j})=>j),drafts:d.drafts.map(({packet,...x})=>({...x,content_hash:x.deliverable?digest(x.deliverable):null,assignment_brief:packet?.assignment,source_names:packet?.sources?.map(s=>s.name)||[],context_warnings:packet?.warnings||[]})),proposals:d.proposals,plan:d.plan,connection:d.connection?{origin:d.connection.origin,name:d.connection.name}:null,ai:d.ai?{email:d.ai.email,plan_enabled:d.ai.scopes?.includes('chatgpt.tokens.use.direct'),model:d.model}:null,identity:{name:d.identity.name,email:d.identity.email},local:localMode()};}
