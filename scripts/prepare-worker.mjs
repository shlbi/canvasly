import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

/** Fetch the pinned upstream sandbox profile and verify Git's blob hash before Docker can use it. */
async function prepare() {
  const url = 'https://raw.githubusercontent.com/microsoft/playwright/v1.64.0/utils/docker/seccomp_profile.json';
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Sandbox profile download failed (${response.status}).`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const sha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  if (sha !== 'fddc05fb520affb145404e6f6f647ca96af8087d') throw new Error('Upstream sandbox profile checksum does not match the reviewed version.');
  const profile = JSON.parse(bytes);
  if (profile.defaultAction !== 'SCMP_ACT_ERRNO' || !Array.isArray(profile.syscalls)) throw new Error('Invalid sandbox profile.');
  await writeFile(new URL('../worker/seccomp-profile.json', import.meta.url), bytes, { mode: 0o644 });
  console.log('Pinned Playwright sandbox profile is ready. Start the worker with Docker Compose.');
}

prepare().catch(/** Stop rather than starting Chromium with its sandbox disabled. */ error => { console.error(error.message); process.exitCode = 1; });
