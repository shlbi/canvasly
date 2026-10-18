// Simple local .env reader (no shell evaluation, existing environment wins).
import { readFileSync } from 'node:fs';
import path from 'node:path';
export function loadLocalEnv(file = path.resolve('.env')) {
  let raw;
  try { raw = readFileSync(file, 'utf8'); } catch (err) { if (err.code === 'ENOENT') return; throw err; }
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const [, key, rest] = match;
    let value = rest.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}
