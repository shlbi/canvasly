// Small, dependency-free Canvas API client. No arbitrary URL-fetching tools.
const MAX_PAGES = 5;
const PER_PAGE = 100;
const MAX_BODY_CHARS = 18000;

export function validatedBaseUrl(value) {
  if (!value) throw new Error('Set CANVAS_BASE_URL to your Canvas origin, e.g. https://school.instructure.com');
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error('CANVAS_BASE_URL must be a valid URL'); }
  const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(isLocal && parsed.protocol === 'http:')) {
    throw new Error('CANVAS_BASE_URL must be HTTPS (except localhost for development)');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
    throw new Error('CANVAS_BASE_URL must be a plain origin with no path, credentials, or query');
  }
  return parsed.origin;
}

function canvasPath(value) {
  if (!value.startsWith('/api/v1/')) throw new Error('Only Canvas API paths are permitted');
  if (value.includes('..') || value.includes('//')) throw new Error('Invalid Canvas API path');
  return value;
}
export function courseId(value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid positive course ID');
  return value;
}
export function integerId(value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid positive ID');
  return value;
}
function safeSlug(value) {
  if (!/^[A-Za-z0-9._~-]{1,150}$/.test(value) || value === '.' || value === '..') {
    throw new Error('Invalid page URL slug');
  }
  return value;
}

export function cleanHtml(input = '') {
  const html = String(input || '').slice(0, 100000);
  return html
    .replace(/<\s*(script|style|svg|iframe|form)\b[^>]*>[\s\S]*?<\/\s*\1\s*>/gi, ' ')
    .replace(/<!--([\s\S]*?)-->/g, ' ')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/\s*(p|div|li|h[1-6]|tr)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_BODY_CHARS);
}

function compactAssignment(a) {
  return {
    id: a.id,
    name: a.name,
    course_id: a.course_id,
    due_at: a.due_at ?? null,
    unlock_at: a.unlock_at ?? null,
    lock_at: a.lock_at ?? null,
    html_url: a.html_url,
    points_possible: a.points_possible ?? null,
    submission_types: a.submission_types ?? [],
    has_submitted_submissions: a.has_submitted_submissions ?? null,
    submission: a.submission ? {
      submitted_at: a.submission.submitted_at ?? null,
      workflow_state: a.submission.workflow_state ?? null,
      late: a.submission.late ?? null,
      missing: a.submission.missing ?? null,
      score: a.submission.score ?? null,
      grade: a.submission.grade ?? null
    } : undefined
  };
}

function parseNextLink(value) {
  if (!value) return null;
  for (const part of value.split(',')) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="?next"?/i);
    if (match) return match[1];
  }
  return null;
}

export class CanvasClient {
  constructor({ baseUrl, token, fetchImpl = fetch }) {
    this.baseUrl = validatedBaseUrl(baseUrl);
    if (!token || typeof token !== 'string') throw new Error('Set CANVAS_API_TOKEN');
    this.token = token;
    this.fetchImpl = fetchImpl;
  }

  async request(path, { params = {}, paginate = false, maxPages = MAX_PAGES } = {}) {
    const url = new URL(this.baseUrl + canvasPath(path));
    for (const [key, values] of Object.entries(params)) {
      if (values === null || values === undefined) continue;
      for (const v of Array.isArray(values) ? values : [values]) url.searchParams.append(key, String(v));
    }
    if (paginate && !url.searchParams.has('per_page')) url.searchParams.set('per_page', String(PER_PAGE));
    let next = url.toString();
    const all = [];
    const seen = new Set();
    for (let page = 0; next && page < (paginate ? Math.min(maxPages, MAX_PAGES) : 1); page++) {
      const target = new URL(next);
      if (target.origin !== this.baseUrl || !target.pathname.startsWith('/api/v1/')) {
        throw new Error('Refusing cross-origin or non-API Canvas pagination URL');
      }
      if (seen.has(next)) throw new Error('Canvas pagination loop detected');
      seen.add(next);
      const response = await this.fetchImpl(target.toString(), {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(15000)
      });
      if (!response.ok) {
        const label = response.status === 401 ? 'Unauthorized: check your Canvas token' :
          response.status === 403 ? 'Forbidden: Canvas account lacks permission or institution blocks this API' :
          response.status === 404 ? 'Not found or inaccessible in Canvas' :
          response.status === 429 ? 'Rate limited by Canvas, retry later' :
          `Canvas API request failed (HTTP ${response.status})`;
        throw new Error(label);
      }
      const body = await response.json();
      if (paginate) {
        if (!Array.isArray(body)) throw new Error('Canvas returned non-list response');
        all.push(...body);
        next = parseNextLink(response.headers.get('link'));
      } else return body;
    }
    return all;
  }

  // Canvas assignment submissions use application/x-www-form-urlencoded field names.
  async postForm(apiPath, fields) {
    const form = new URLSearchParams();
    for (const [key, values] of Object.entries(fields)) {
      for (const value of Array.isArray(values) ? values : [values]) form.append(key, String(value));
    }
    const response = await this.fetchImpl(this.baseUrl + canvasPath(apiPath), {
      method: 'POST', headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(), redirect: 'error', signal: AbortSignal.timeout(30000)
    });
    if (!response.ok) throw new Error(`Canvas write failed (HTTP ${response.status})`);
    return response.json();
  }
  async submitAssignment(cid, aid, type, fields) {
    if (!['online_text_entry', 'online_url', 'online_upload'].includes(type)) throw new Error('Unsupported submission type');
    return this.postForm(`/api/v1/courses/${courseId(cid)}/assignments/${integerId(aid)}/submissions`, {
      'submission[submission_type]': type, ...fields
    });
  }
  async uploadSubmissionFile(cid, aid, { name, data, contentType = 'application/octet-stream' }) {
    const init = await this.postForm(`/api/v1/courses/${courseId(cid)}/assignments/${integerId(aid)}/submissions/self/files`, {
      name, size: data.length, content_type: contentType
    });
    const upload = new URL(init.upload_url);
    if (upload.protocol !== 'https:' && !(upload.origin === this.baseUrl && upload.protocol === 'http:')) throw new Error('Unsafe Canvas upload destination');
    if (upload.username || upload.password) throw new Error('Credentials in Canvas upload destination');
    if (upload.origin !== this.baseUrl && (/^(localhost|.*\.localhost)$/i.test(upload.hostname) || /^[0-9.]+$/.test(upload.hostname) || upload.hostname.includes(':'))) throw new Error('Refusing internal or IP-literal external upload destination');
    const form = new FormData();
    for (const [key, value] of Object.entries(init.upload_params || {})) form.append(key, String(value));
    form.append('file', new Blob([data], { type: contentType }), name);
    // Upload destinations can be S3; NEVER forward Canvas bearer token to them.
    const response = await this.fetchImpl(upload.toString(), { method: 'POST', body: form, redirect: 'manual', signal: AbortSignal.timeout(120000) });
    let detail;
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const redirect = new URL(response.headers.get('location') || '', upload);
      if (redirect.origin !== this.baseUrl || !redirect.pathname.startsWith('/api/v1/')) throw new Error('Canvas file upload returned an untrusted redirect; finish upload manually');
      const follow = await this.fetchImpl(redirect.toString(), { method: 'GET', headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(30000) });
      if (!follow.ok) throw new Error(`Canvas upload finalization failed (HTTP ${follow.status})`);
      detail = await follow.json();
    } else {
      if (!response.ok) throw new Error(`Canvas file upload failed (HTTP ${response.status})`);
      detail = await response.json();
    }
    if (!detail?.id) throw new Error('Canvas did not return an uploaded attachment ID');
    return { id: detail.id, display_name: detail.display_name };
  }

  getSelf() { return this.request('/api/v1/users/self/profile'); }
  listCourses() { return this.request('/api/v1/courses', { params: { enrollment_state: 'active', 'include[]': ['total_scores', 'syllabus_body'] }, paginate: true, maxPages: 3 }); }
  getCourse(id) { return this.request(`/api/v1/courses/${courseId(id)}`, { params: { 'include[]': ['syllabus_body', 'total_scores'] } }); }
  listAssignments(id) { return this.request(`/api/v1/courses/${courseId(id)}/assignments`, { params: { 'include[]': 'submission' }, paginate: true }); }
  getAssignment(id, assignmentId) { return this.request(`/api/v1/courses/${courseId(id)}/assignments/${integerId(assignmentId)}`, { params: { 'include[]': 'submission' } }); }
  listModules(id) { return this.request(`/api/v1/courses/${courseId(id)}/modules`, { paginate: true, maxPages: 3 }); }
  listModuleItems(id, moduleId) { return this.request(`/api/v1/courses/${courseId(id)}/modules/${integerId(moduleId)}/items`, { paginate: true, maxPages: 2 }); }
  getPage(id, slug) { return this.request(`/api/v1/courses/${courseId(id)}/pages/${encodeURIComponent(safeSlug(slug))}`); }
  getTodo() { return this.request('/api/v1/users/self/todo', { paginate: true, maxPages: 2 }); }
  getUpcoming() { return this.request('/api/v1/users/self/upcoming_events', { paginate: true, maxPages: 2 }); }
  getAnnouncements(id) { return this.request('/api/v1/announcements', { params: { 'context_codes[]': `course_${courseId(id)}`, 'active_only': true }, paginate: true, maxPages: 2 }); }
}

export function summarizeCourse(course) {
  const enrollment = (course.enrollments || []).find(e => e.type === 'student' || e.role === 'StudentEnrollment') || null;
  return {
    id: course.id,
    name: course.name,
    code: course.course_code,
    workflow_state: course.workflow_state,
    term: course.term?.name ?? null,
    url: course.html_url || null,
    current_score: enrollment?.computed_current_score ?? null,
    final_score: enrollment?.computed_final_score ?? null
  };
}
export { compactAssignment };

export function radarFromAssignments(coursesAndAssignments, now = new Date(), horizonDays = 14) {
  const deadline = now.getTime() + horizonDays * 86400000;
  const results = [];
  for (const { course, assignments } of coursesAndAssignments) {
    for (const a of assignments) {
      const due = a.due_at ? Date.parse(a.due_at) : NaN;
      const sub = a.submission || {};
      if (!Number.isFinite(due) || due > deadline) continue;
      const done = Boolean(sub.submitted_at) || ['submitted', 'graded', 'pending_review'].includes(sub.workflow_state);
      results.push({
        course: course.name,
        course_id: course.id,
        assignment_id: a.id,
        title: a.name,
        due_at: a.due_at,
        days_until_due: Math.round(((due - now.getTime()) / 86400000) * 10) / 10,
        status: done ? 'submitted' : (due < now.getTime() ? 'overdue_or_missing' : 'upcoming'),
        submission_missing: sub.missing ?? null,
        html_url: a.html_url || null,
        points_possible: a.points_possible ?? null
      });
    }
  }
  const priority = { overdue_or_missing: 0, upcoming: 1, submitted: 2 };
  return results.sort((a, b) => priority[a.status] - priority[b.status] || Date.parse(a.due_at) - Date.parse(b.due_at));
}

export async function assignmentPacket(client, cid, aid, relatedPageLimit = 3) {
  const [assignment, modules] = await Promise.all([
    client.getAssignment(cid, aid),
    client.listModules(cid)
  ]);
  let moduleName = null;
  let moduleItems = [];
  // Canvas modules endpoint can include items, but we independently load the first matching module.
  for (const m of modules.slice(0, 35)) {
    const items = await client.listModuleItems(cid, m.id);
    if (items.some(item => item.type === 'Assignment' && Number(item.content_id) === aid)) {
      moduleName = m.name;
      moduleItems = items;
      break;
    }
  }
  const modulePages = moduleItems.filter(i => i.type === 'Page' && i.page_url).slice(0, relatedPageLimit);
  const resources = await Promise.all(modulePages.map(async item => {
    try {
      const p = await client.getPage(cid, item.page_url);
      return { title: p.title, url: p.html_url, text: cleanHtml(p.body) };
    } catch { return { title: item.title, unavailable: true }; }
  }));
  return {
    assignment: { ...compactAssignment(assignment), instructions: cleanHtml(assignment.description), rubric: assignment.rubric ?? null },
    module: moduleName,
    related_materials: resources,
    module_item_links: moduleItems.slice(0, 30).map(i => ({ title: i.title, type: i.type, url: i.html_url }))
  };
}
