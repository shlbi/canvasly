import { handler } from '../lib/app/api.mjs';

/** Adapt the standard Web Request to the shared router while preserving exact webhook bytes and cookies. */
async function fetchRequest(request) {
  const headers = Object.fromEntries(request.headers);
  const req = { method: request.method, url: request.url, headers, socket: {},
    [Symbol.asyncIterator]: /* Stream a bounded body rather than allocating an unbounded request. */ async function* () { if (request.body) for await (const chunk of request.body) yield chunk; } };
  const output = new Headers(); let status = 200, result = '';
  const res = {
    setHeader: /* Preserve repeated Set-Cookie headers as separate fields. */ (name, value) => { output.delete(name); for (const item of Array.isArray(value) ? value : [value]) output.append(name, String(item)); },
    getHeader: /* The cookie writer appends to existing cookies, not a comma-joined string. */ name => name.toLowerCase() === 'set-cookie' ? output.getSetCookie() : output.get(name),
    writeHead: /* Apply redirects without exposing the response implementation to route modules. */ (code, values) => { status = code; for (const [name, value] of Object.entries(values || {})) output.set(name, value); },
    end: /* Capture one bounded non-streaming JSON response. */ value => { result = value || ''; },
    /** Read the response status used by the shared Node router. */
    get statusCode() { return status; },
    /** Set the response status without committing headers early. */
    set statusCode(value) { status = value; }
  };
  await handler(req, res);
  return new Response(status === 204 ? null : result, { status, headers: output });
}

export default { fetch: fetchRequest };
