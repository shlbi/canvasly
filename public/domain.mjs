// Shared by the website, worker and MCP. No model calls or browser dependencies.
export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const minute = value => { if (!/^\d{2}:\d{2}$/.test(value || '')) throw new Error('Use a time such as 17:00.'); const [h,m] = value.split(':').map(Number); if(h>23 || m>59) throw new Error('Invalid time.'); return h*60+m; };
const number = (v,min,max,label) => { const n=Number(v); if(!Number.isFinite(n)||n<min||n>max) throw new Error(`${label} must be between ${min} and ${max}.`); return n; };
const text = (v,max=200) => String(v??'').trim().slice(0,max);
export function defaultProfile() { return { confirmed:false, name:'', timezone:'America/New_York', study_window:{start:'10:00',end:'21:00'}, session_minutes:45, break_minutes:15, max_daily_minutes:120, preferences:{format:'worked-examples',detail:'step-by-step',notes:''}, commitments:[], course_settings:[], observations:[], memories:[] }; }
export function validateProfile(input) {
  if(!input || typeof input!=='object') throw new Error('A profile is required.');
  const p={...defaultProfile(),...input}; new Intl.DateTimeFormat('en-US',{timeZone:p.timezone}).format();
  const window=p.study_window; minute(window?.start); minute(window?.end); if(window.start===window.end) throw new Error('Study window start and end must differ.');
  if(!Array.isArray(p.commitments)||p.commitments.length>80) throw new Error('Use at most 80 commitments.');
  const commitments=p.commitments.map(c=>{ minute(c.start);minute(c.end); if(c.start===c.end) throw new Error('Commitments need different start and end times.'); if(!Array.isArray(c.days)||!c.days.length||!c.days.every(d=>Number.isInteger(d)&&d>=0&&d<7)) throw new Error('Choose the days this commitment starts.'); return {id:text(c.id,80),title:text(c.title,100)||'Commitment',kind:['work','class','sleep','commute','activity','personal'].includes(c.kind)?c.kind:'personal',days:[...new Set(c.days)],start:c.start,end:c.end,buffer_minutes:number(c.buffer_minutes??0,0,180,'Buffer'),source:'you'}; });
  return { confirmed:p.confirmed===true, name:text(p.name,80),timezone:p.timezone,study_window:{start:window.start,end:window.end},session_minutes:number(p.session_minutes,15,120,'Session length'),break_minutes:number(p.break_minutes,0,60,'Break'),max_daily_minutes:number(p.max_daily_minutes,15,720,'Daily study cap'),preferences:{format:['worked-examples','practice-first','short-explanations','visual-explanations','mixed'].includes(p.preferences?.format)?p.preferences.format:'mixed',detail:['step-by-step','concise','adaptive'].includes(p.preferences?.detail)?p.preferences.detail:'adaptive',notes:text(p.preferences?.notes,2000)},commitments,course_settings:(Array.isArray(p.course_settings)?p.course_settings:[]).slice(0,50).map(c=>({id:text(c.id,80),type:text(c.type,80),baseline_minutes:number(c.baseline_minutes||60,15,600,'Course estimate')})),observations:(Array.isArray(p.observations)?p.observations:[]).slice(-200).map(o=>({id:text(o.id,80),course_id:text(o.course_id,80),topic:text(o.topic,180),estimated_minutes:number(o.estimated_minutes,1,1200,'Estimated duration'),actual_minutes:number(o.actual_minutes,1,1200,'Actual duration'),understanding:number(o.understanding,1,5,'Understanding'),format:text(o.format,80),at:text(o.at,40)})),memories:(Array.isArray(p.memories)?p.memories:[]).slice(0,40).map(m=>({id:text(m.id,80),text:text(m.text,1000),source:'you',at:text(m.at,40)})) };
}
export function coursePace(profile,courseId) {
  const observations=profile.observations.filter(o=>String(o.course_id)===String(courseId));
  const ratios=observations.map(o=>o.actual_minutes/o.estimated_minutes).sort((a,b)=>a-b);
  const n=ratios.length, median=n?ratios[Math.floor(n/2)]:1;
  // Early observations are provisional. Shrink toward the student's initial estimate.
  const weight=n<3?0:Math.min(.8,n/(n+4));
  return {factor:Math.max(.5,Math.min(2.5,1+(median-1)*weight)),samples:n,confidence:n<3?'not enough history':n<8?'early estimate':'based on your check-ins',understanding:n?observations.reduce((s,o)=>s+o.understanding,0)/n:null};
}
const formatters=new Map();
export function localParts(date,timezone) {
  if(!formatters.has(timezone)) formatters.set(timezone,new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23',weekday:'short'}));
  const p=Object.fromEntries(formatters.get(timezone).formatToParts(new Date(date)).map(x=>[x.type,x.value]));
  return {date:`${p.year}-${p.month}-${p.day}`,weekday:WEEKDAYS.indexOf(p.weekday),minutes:Number(p.hour)*60+Number(p.minute),time:`${p.hour}:${p.minute}`};
}
function occurrenceBlocks(commitment,parts) {
  const start=minute(commitment.start), end=minute(commitment.end), duration=(end-start+1440)%1440;
  for(const offset of [-1,0,1]) { const day=(parts.weekday+offset+7)%7; if(!commitment.days.includes(day))continue; const a=offset*1440+start-commitment.buffer_minutes,b=offset*1440+start+duration+commitment.buffer_minutes; if(parts.minutes>=a&&parts.minutes<b)return true; } return false;
}
export function blockedBy(profile,time) { const p=localParts(time,profile.timezone);return profile.commitments.filter(c=>occurrenceBlocks(c,p)); }
export function isAvailable(profile,time) { const p=localParts(time,profile.timezone),a=minute(profile.study_window.start),b=minute(profile.study_window.end);return (a<b?p.minutes>=a&&p.minutes<b:p.minutes>=a||p.minutes<b)&&blockedBy(profile,time).length===0; }
export function buildStudyPlan(profile, assignments, {now=new Date(),days=7,delegated=[]}={}) {
  const p=validateProfile(profile),start=Math.ceil(+new Date(now)/900000)*900000, horizon=start+Math.max(1,Math.min(14,days))*86400000;
  const slots=[];for(let t=start;t<horizon;t+=900000) { const end=t+900000; if(isAvailable(p,t)&&isAvailable(p,end-1)) slots.push({start:t,end,date:localParts(t,p.timezone).date}); }
  const spent=new Map(),used=new Set(),sessions=[],unscheduled=[];
  const delegatedKeys=new Set(delegated.map(x=>`${x.course_id}:${x.assignment_id}`));
  const tasks=assignments.filter(a=>!a.submitted&&!delegatedKeys.has(`${a.course_id}:${a.id}`)).slice().sort((a,b)=>Date.parse(a.due_at||'2999-01-01')-Date.parse(b.due_at||'2999-01-01'));
  for(const a of tasks) {
    const setting=p.course_settings.find(c=>String(c.id)===String(a.course_id)),pace=coursePace(p,a.course_id);
    let remaining=Math.ceil(Number(a.estimated_minutes||setting?.baseline_minutes||60)*pace.factor/15)*15; const total=remaining;
    const due=a.due_at?Date.parse(a.due_at):horizon;if(!Number.isFinite(due)) {unscheduled.push({id:a.id,title:a.name,remaining_minutes:remaining,reason:'Invalid due date; check Canvas.'});continue;}
    for(let i=0;i<slots.length&&remaining>0;i++) {
      const s=slots[i];if(used.has(s.start)||s.end>due)continue;
      let cap=Math.min(remaining,Math.floor(p.session_minutes/15)*15,Math.floor((p.max_daily_minutes-(spent.get(s.date)||0))/15)*15);if(cap<15)continue;
      const group=[s];for(let j=i+1;j<slots.length&&group.length*15<cap;j++){const n=slots[j];if(n.start!==group.at(-1).end||n.date!==s.date||used.has(n.start)||n.end>due)break;group.push(n);}
      const duration=group.length*15;const end=group.at(-1).end;group.forEach(x=>used.add(x.start));
      // Reserve break time too, even when the next assignment is different.
      for(let t=end;t<end+p.break_minutes*60000;t+=900000) used.add(t);
      sessions.push({assignment_id:a.id,course_id:a.course_id,title:a.name,start:new Date(s.start).toISOString(),end:new Date(end).toISOString(),minutes:duration,estimate_minutes:total,estimate_basis:pace.confidence});
      spent.set(s.date,(spent.get(s.date)||0)+duration);remaining-=duration;
    }
    if(remaining>0)unscheduled.push({id:a.id,title:a.name,remaining_minutes:remaining,reason:due<=start?'Deadline has passed. Choose how to handle it.':'Not enough available time before the deadline. Adjust scope, availability, or delegate.'});
  }
  return {sessions,unscheduled,total_minutes:sessions.reduce((n,s)=>n+s.minutes,0),timezone:p.timezone,generated_at:new Date(now).toISOString(),note:'A time estimate, not a promise. Commitments, breaks, your daily cap and recorded learning pace are respected.'};
}
