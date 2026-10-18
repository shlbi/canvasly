import { AppError, canvasOrigin, storageUrl, id, plain, fingerprint, escapeHtml, validateDeliverable } from './security.mjs';
export async function limitedBody(response, max = 1100000) {
  if (Number(response.headers.get('content-length') || 0) > max) throw new AppError('File exceeds the 1 MB source limit.');
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > max) throw new AppError('Source file is too large.'); chunks.push(Buffer.from(value)); } }
  finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks);
}
export class Canvas {
  constructor(origin, token, fetchImpl = fetch) { this.origin = canvasOrigin(origin); this.token = token; this.fetch = fetchImpl; this.warnings = []; this.deadline = AbortSignal.timeout(47000); }
  async api(path, fields, paginate = false) {
    if (!path.startsWith('/api/v1/') || path.includes('..') || path.includes('//')) throw new AppError('Invalid Canvas API path.');
    let next = new URL(path, this.origin).href; const all = [], seen = new Set();
    for (let page = 0; next && page < 8; page++) {
      const u = new URL(next);
      if (u.origin !== this.origin || !u.pathname.startsWith('/api/v1/') || seen.has(next)) throw new AppError('Canvas returned unsafe pagination.', 502);
      seen.add(next);
      const response = await this.fetch(u, { method: fields ? 'POST' : 'GET', headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json', ...(fields ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) }, ...(fields ? { body: fields.toString() } : {}), redirect: 'error', signal: AbortSignal.any([this.deadline, AbortSignal.timeout(12000)]) });
      if (!response.ok) throw new AppError(response.status === 401 ? 'Canvas token expired or invalid. Reconnect in Settings.' : response.status === 403 ? 'Canvas denied access to this resource.' : response.status === 429 ? 'Canvas rate limit reached. Retry later.' : `Canvas request failed (${response.status}).`, response.status === 429 ? 429 : 502);
      const data = await response.json();
      if (!paginate) return data;
      if (!Array.isArray(data)) throw new AppError('Canvas returned an unexpected list.', 502);
      all.push(...data);
      next = (response.headers.get('link') || '').split(',').map(v => v.match(/<([^>]+)>;\s*rel="?next"?/)).find(Boolean)?.[1];
    }
    if (next) this.warnings.push('A Canvas list exceeded 800 records; the current view is partial.');
    return all;
  }
  self() { return this.api('/api/v1/users/self/profile'); }
  courses() { return this.api('/api/v1/courses?enrollment_state=active&per_page=100', null, true); }
  assignments(cid) { return this.api(`/api/v1/courses/${id(cid)}/assignments?include[]=submission&per_page=100`, null, true); }
  assignment(cid, aid) { return this.api(`/api/v1/courses/${id(cid)}/assignments/${id(aid)}?include[]=submission`); }
  async snapshot() {
    const raw = await this.courses();
    const courses = raw.filter(c => c.name && c.workflow_state !== 'deleted').slice(0, 24).map(c => ({ id: c.id, name: c.name, code: c.course_code || c.name, url: `${this.origin}/courses/${c.id}` }));
    if (raw.length > 24) this.warnings.push('This view includes the first 24 active courses.');
    const assignments = [];
    for (let i = 0; i < courses.length; i += 3) await Promise.all(courses.slice(i, i + 3).map(async c => {
      try { assignments.push(...(await this.assignments(c.id)).map(a => compact(a, c.id))); }
      catch (e) { this.warnings.push(`${c.code}: ${e.message}`); }
    }));
    return { courses, assignments, warnings: this.warnings, synced_at: new Date().toISOString() };
  }
  async readFile(fid, name) {
    const meta = await this.api(`/api/v1/files/${id(fid)}`);
    if (meta.locked_for_user || meta.hidden_for_user) throw new AppError('File is locked.');
    if (meta.size > 1000000) throw new AppError('File exceeds the 1 MB source limit.');
    const filename = meta.display_name || name || 'source';
    const pdf = /\.pdf$/i.test(filename) || meta['content-type'] === 'application/pdf';
    if (!pdf && !/\.(txt|md|csv|json|py|js|ts|html|css|java|c|cpp|sql)$/i.test(filename)) throw new AppError('This file format needs manual export to PDF or text.');
    let u = storageUrl(meta.url, this.origin), response;
    for (let i = 0; i < 4; i++) {
      response = await this.fetch(u, { headers: u.origin === this.origin ? { Authorization: `Bearer ${this.token}` } : {}, redirect: 'manual', signal: AbortSignal.any([this.deadline, AbortSignal.timeout(12000)]) });
      if ([301, 302, 303, 307, 308].includes(response.status)) { u = storageUrl(new URL(response.headers.get('location'), u).href, this.origin); continue; }
      break;
    }
    if (!response?.ok) throw new AppError('Could not download this Canvas file.');
    const buffer = await limitedBody(response, 1000000);
    if (pdf && !buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new AppError('Source did not contain a valid PDF header.');
    return pdf ? { name: filename, kind: 'pdf', data: `data:application/pdf;base64,${buffer.toString('base64')}` } : { name: filename, kind: 'text', text: /\.html?$/i.test(filename) ? plain(buffer.toString('utf8'), 25000) : buffer.toString('utf8').slice(0, 25000) };
  }
  async packet(cid, aid) {
    const a = await this.assignment(cid, aid);
    const sources = [], warnings = [], fileRefs = [...String(a.description || '').matchAll(/\/files\/(\d+)/g)].map(m => ({ id: Number(m[1]), name: 'Assignment attachment' }));
    try {
      const modules = await this.api(`/api/v1/courses/${id(cid)}/modules?include[]=items&per_page=100`, null, true);
      let found = false;
      for (const module of modules.slice(0, 20)) {
        const items = module.items && module.items.length >= module.items_count ? module.items : await this.api(`/api/v1/courses/${id(cid)}/modules/${id(module.id)}/items?per_page=100`, null, true);
        if (!items.some(i => i.type === 'Assignment' && i.content_id === Number(aid))) continue;
        found = true;
        for (const p of items.filter(i => i.type === 'Page').slice(0, 3)) {
          try {
            const page = await this.api(`/api/v1/courses/${id(cid)}/pages/${encodeURIComponent(p.page_url)}`);
            sources.push({ name: page.title, kind: 'text', text: plain(page.body, 20000) });
          } catch { warnings.push(`Could not read ${p.title}.`); }
        }
        fileRefs.push(...items.filter(i => i.type === 'File').map(i => ({ id: i.content_id, name: i.title })));
        if (items.filter(i => i.type === 'Page').length > 3) warnings.push('Only the first three related module pages were included.');
        break;
      }
      if (!found) warnings.push('No matching assignment module was found in the first 20 modules.');
    } catch { warnings.push('Some module materials were unavailable; assignment instructions are still included.'); }
    const unique = [...new Map(fileRefs.map(f => [f.id, f])).values()];
    for (const f of unique.slice(0, 2)) {
      try { sources.push(await this.readFile(f.id, f.name)); }
      catch (e) { warnings.push(`${f.name}: ${e.message}`); }
    }
    if (unique.length > 2) warnings.push('Only the first two attached files were read. Add any remaining essential context before running the agent.');
    return { assignment: { ...compact(a, cid), instructions: plain(a.description), rubric: a.rubric || [], fingerprint: fingerprint(a) }, sources, warnings: [...warnings, ...this.warnings] };
  }
  async upload(cid, aid, file) {
    const data = Buffer.from(file.content), init = await this.api(`/api/v1/courses/${id(cid)}/assignments/${id(aid)}/submissions/self/files`, new URLSearchParams({ name: file.name, size: String(data.length), content_type: 'text/plain' }));
    const target = storageUrl(init.upload_url, this.origin), form = new FormData();
    for (const [k, v] of Object.entries(init.upload_params || {})) form.append(k, String(v));
    form.append('file', new Blob([data], { type: 'text/plain' }), file.name);
    let res = await this.fetch(target, { method: 'POST', body: form, redirect: 'manual', signal: AbortSignal.any([this.deadline, AbortSignal.timeout(20000)]) });
    if ([301, 302, 303].includes(res.status)) {
      const next = new URL(res.headers.get('location'), target);
      if (next.origin !== this.origin || !next.pathname.startsWith('/api/v1/')) throw new AppError('Upload needs manual Canvas verification.');
      res = await this.fetch(next, { headers: { Authorization: `Bearer ${this.token}` }, redirect: 'error', signal: this.deadline });
    }
    if (!res.ok) throw new AppError('File upload failed. Check Canvas before retrying.');
    const result = await res.json(); return id(result.id);
  }
  async submit(cid, aid, deliverable, live) {
    assertOpen(live);
    const d = validateDeliverable(deliverable, live.submission_types);
    const fields = new URLSearchParams({ 'submission[submission_type]': d.type });
    if (d.type === 'online_text_entry') fields.set('submission[body]', `<pre>${escapeHtml(d.body)}</pre>`);
    if (d.type === 'online_url') fields.set('submission[url]', d.url);
    if (d.type === 'online_upload') {
      for (const f of d.files) {
        if (live.allowed_extensions?.length && !live.allowed_extensions.map(e => e.toLowerCase()).includes(f.name.split('.').pop().toLowerCase())) throw new AppError(`Canvas does not accept ${f.name}'s extension.`);
      }
      for (const f of d.files) fields.append('submission[file_ids][]', String(await this.upload(cid, aid, f)));
    }
    return this.api(`/api/v1/courses/${id(cid)}/assignments/${id(aid)}/submissions`, fields);
  }
}
export function assertOpen(a) {
  if (a.locked_for_user || (a.lock_at && Date.parse(a.lock_at) < Date.now()) || (a.unlock_at && Date.parse(a.unlock_at) > Date.now())) throw new AppError('This assignment is locked in Canvas.', 403);
  if (a.is_quiz_assignment || a.quiz_id || !a.submission_types?.some(t => ['online_text_entry', 'online_upload', 'online_url'].includes(t))) throw new AppError('This assignment requires its native Canvas or external-tool workflow. Quizzes, discussions, and external tools are not automated.', 422);
}
export function compact(a, cid) {
  const s = a.submission || {};
  return { id: a.id, course_id: Number(cid), name: a.name, due_at: a.due_at || null, lock_at: a.lock_at || null, unlock_at: a.unlock_at || null, points_possible: a.points_possible, url: a.html_url, submission_types: a.submission_types || [], allowed_extensions: a.allowed_extensions || [], locked_for_user: !!a.locked_for_user, is_quiz_assignment: !!a.is_quiz_assignment, quiz_id: a.quiz_id || null, submitted: !!s.submitted_at || ['submitted', 'graded', 'pending_review'].includes(s.workflow_state), submission_state: s.workflow_state || 'unsubmitted', submitted_at: s.submitted_at || null, grade: s.grade || null, score: s.score ?? null };
}
