import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import {
  listSkills,
  getSkill,
  putSkill,
  deleteSkill,
  renameSkill,
  listSchedules,
  putSchedule,
  deleteSchedule,
  listLastRuns,
  type Schedule,
} from './redis';
import { isValidCron, runNow } from './scheduler';

const COOKIE_NAME = 'skillit_admin';
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const SKILL_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;
const MAX_SKILL_BYTES = 256 * 1024;

const here = dirname(fileURLToPath(import.meta.url));
const adminHtml = readFileSync(join(here, 'static', 'admin.html'), 'utf8');

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`[skillit] required env var ${name} is not set`);
  return v;
}

function sessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (secret) return secret;
  // Allow boot in dev with an ephemeral secret; sessions won't survive a restart.
  const fallback = randomBytes(32).toString('hex');
  console.warn('[skillit] SESSION_SECRET not set — using ephemeral secret (sessions reset on restart)');
  process.env.SESSION_SECRET = fallback;
  return fallback;
}

function adminPassword(): string {
  return requireEnv('ADMIN_PASSWORD');
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function signToken(expiresAt: number): string {
  const payload = `admin.${expiresAt}`;
  const mac = createHmac('sha256', sessionSecret()).update(payload).digest('hex');
  return `${payload}.${mac}`;
}

function verifyToken(token: string | undefined): boolean {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [scope, expiresStr, mac] = parts;
  if (scope !== 'admin') return false;
  const expiresAt = Number(expiresStr);
  if (!Number.isFinite(expiresAt) || expiresAt < Math.floor(Date.now() / 1000)) return false;
  const expected = createHmac('sha256', sessionSecret()).update(`${scope}.${expiresStr}`).digest('hex');
  if (expected.length !== mac.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(mac));
}

function getCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get('cookie');
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return undefined;
}

function buildSessionCookie(token: string): string {
  return [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ].join('; ');
}

function clearCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

function isAuthed(req: Request): boolean {
  return verifyToken(getCookie(req, COOKIE_NAME));
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

function unauthorized(): Response {
  return json({ error: 'unauthorized' }, { status: 401 });
}

function skillNameFromFile(filename: string): string {
  return filename.replace(/\.(md|markdown|txt)$/i, '');
}

async function handleLogin(req: Request): Promise<Response> {
  let password = '';
  try {
    const body = await req.json() as { password?: unknown };
    if (typeof body?.password === 'string') password = body.password;
  } catch {
    return json({ error: 'invalid_json' }, { status: 400 });
  }
  if (!password || !constantTimeEqual(password, adminPassword())) {
    return json({ error: 'invalid_password' }, { status: 401 });
  }
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  return json({ ok: true }, { headers: { 'set-cookie': buildSessionCookie(signToken(expiresAt)) } });
}

function handleLogout(): Response {
  return json({ ok: true }, { headers: { 'set-cookie': clearCookie() } });
}

async function handleListSkills(): Promise<Response> {
  const [skills, schedules, lastRuns] = await Promise.all([
    listSkills(),
    listSchedules(),
    listLastRuns(),
  ]);
  return json({
    skills: skills.map((s) => ({
      name: s.name,
      size: Buffer.byteLength(s.content, 'utf8'),
      schedule: schedules[s.name] ?? null,
      lastRun: lastRuns[s.name] ?? null,
    })),
  });
}

async function handlePutSchedule(name: string, req: Request): Promise<Response> {
  if (!SKILL_NAME_PATTERN.test(name)) return json({ error: 'invalid_name' }, { status: 400 });
  const skillExists = (await listSkills()).some((s) => s.name === name);
  if (!skillExists) return json({ error: 'skill_not_found' }, { status: 404 });

  let body: Partial<Schedule>;
  try {
    body = await req.json() as Partial<Schedule>;
  } catch {
    return json({ error: 'invalid_json' }, { status: 400 });
  }

  const cronExpr = typeof body.cron === 'string' ? body.cron.trim() : '';
  const prompt = typeof body.prompt === 'string' ? body.prompt : '';
  const tz = typeof body.tz === 'string' && body.tz.trim() ? body.tz.trim() : undefined;
  const slackChannel = typeof body.slackChannel === 'string' && body.slackChannel.trim()
    ? body.slackChannel.trim()
    : undefined;

  if (!cronExpr) return json({ error: 'cron_required' }, { status: 400 });
  if (!isValidCron(cronExpr)) return json({ error: 'invalid_cron' }, { status: 400 });

  const schedule: Schedule = {
    cron: cronExpr,
    prompt: prompt.trim(),
    ...(tz ? { tz } : {}),
    ...(slackChannel ? { slackChannel } : {}),
  };
  await putSchedule(name, schedule);
  return json({ ok: true, schedule });
}

async function handleDeleteSchedule(name: string): Promise<Response> {
  if (!SKILL_NAME_PATTERN.test(name)) return json({ error: 'invalid_name' }, { status: 400 });
  const removed = await deleteSchedule(name);
  return json({ removed });
}

async function handleRunNow(name: string): Promise<Response> {
  if (!SKILL_NAME_PATTERN.test(name)) return json({ error: 'invalid_name' }, { status: 400 });
  try {
    await runNow(name);
    return json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json({ error: message }, { status: 400 });
  }
}

async function handleUploadSkills(req: Request): Promise<Response> {
  const contentType = req.headers.get('content-type') || '';
  if (!contentType.startsWith('multipart/form-data')) {
    return json({ error: 'expected_multipart' }, { status: 400 });
  }
  const form = await req.formData();
  const uploaded: string[] = [];
  const errors: { file: string; reason: string }[] = [];

  const rawName = form.get('name');
  const nameOverride = typeof rawName === 'string' ? rawName.trim() : '';
  const files = form.getAll('files').filter((v) => v instanceof File) as File[];

  for (const value of files) {
    const name = files.length === 1 && nameOverride ? nameOverride : skillNameFromFile(value.name);
    if (!SKILL_NAME_PATTERN.test(name)) {
      errors.push({ file: value.name, reason: 'invalid_name' });
      continue;
    }
    if (value.size > MAX_SKILL_BYTES) {
      errors.push({ file: value.name, reason: 'too_large' });
      continue;
    }
    const text = await value.text();
    await putSkill(name, text);
    uploaded.push(name);
  }

  return json({ uploaded, errors });
}

async function handleRenameSkill(name: string, req: Request): Promise<Response> {
  if (!SKILL_NAME_PATTERN.test(name)) return json({ error: 'invalid_name' }, { status: 400 });
  let body: { name?: unknown };
  try {
    body = await req.json() as { name?: unknown };
  } catch {
    return json({ error: 'invalid_json' }, { status: 400 });
  }
  const newName = typeof body.name === 'string' ? body.name.trim() : '';
  if (!newName) return json({ error: 'name_required' }, { status: 400 });
  if (!SKILL_NAME_PATTERN.test(newName)) return json({ error: 'invalid_name' }, { status: 400 });
  if (newName === name) return json({ ok: true, name: newName });
  const conflict = await getSkill(newName);
  if (conflict) return json({ error: 'name_conflict' }, { status: 409 });
  try {
    await renameSkill(name, newName);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes('not found') ? 404 : 500;
    return json({ error: message }, { status });
  }
  return json({ ok: true, name: newName });
}

async function handleDeleteSkill(name: string): Promise<Response> {
  if (!SKILL_NAME_PATTERN.test(name)) return json({ error: 'invalid_name' }, { status: 400 });
  const removed = await deleteSkill(name);
  return json({ removed });
}

async function route(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (req.method === 'GET' && (path === '/' || path === '/admin')) {
    return new Response(adminHtml, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  }

  if (req.method === 'GET' && path === '/healthz') {
    return new Response('ok');
  }

  if (req.method === 'POST' && path === '/api/admin/login') return handleLogin(req);
  if (req.method === 'POST' && path === '/api/admin/logout') return handleLogout();

  if (path.startsWith('/api/admin/skills')) {
    if (!isAuthed(req)) return unauthorized();

    if (req.method === 'GET' && path === '/api/admin/skills') return handleListSkills();
    if (req.method === 'POST' && path === '/api/admin/skills') return handleUploadSkills(req);

    const sub = path.slice('/api/admin/skills/'.length);
    if (sub) {
      // /api/admin/skills/<name>[/schedule|/run]
      const segments = sub.split('/');
      const name = decodeURIComponent(segments[0]);
      const tail = segments.slice(1).join('/');

      if (!tail) {
        if (req.method === 'DELETE') return handleDeleteSkill(name);
        if (req.method === 'PATCH') return handleRenameSkill(name, req);
      } else if (tail === 'schedule') {
        if (req.method === 'PUT') return handlePutSchedule(name, req);
        if (req.method === 'DELETE') return handleDeleteSchedule(name);
      } else if (tail === 'run') {
        if (req.method === 'POST') return handleRunNow(name);
      }
    }

    return json({ error: 'method_not_allowed' }, { status: 405 });
  }

  if (req.method === 'GET' && path === '/api/admin/session') {
    return json({ authenticated: isAuthed(req) });
  }

  return new Response('Not Found', { status: 404 });
}

export function startFrontend(): void {
  const port = Number(process.env.PORT || 80);
  Bun.serve({
    port,
    fetch: (req) =>
      route(req).catch((err) => {
        console.error('[skillit] request failed', err);
        return json({ error: 'internal' }, { status: 500 });
      }),
  });
  console.log(`[skillit] frontend listening on :${port}`);
}
