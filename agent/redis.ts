import Redis from 'ioredis';

export const SKILLS_HASH_KEY = 'skillit:skills';
export const SKILLS_CHANNEL = 'skillit:skills:changes';
export const SCHEDULES_HASH_KEY = 'skillit:schedules';
export const SCHEDULES_CHANNEL = 'skillit:schedules:changes';
export const LAST_RUN_HASH_KEY = 'skillit:last-run';

// The Astropods built-in redis provider injects REDIS_URL (and REDIS_HOST /
// REDIS_PORT) into the agent container automatically. See `ast docs` →
// Knowledge Stores → Built-in providers.
const url =
  process.env.REDIS_URL ||
  (process.env.REDIS_HOST && process.env.REDIS_PORT
    ? `redis://${process.env.REDIS_HOST}:${process.env.REDIS_PORT}`
    : (() => {
        throw new Error('[skillit] REDIS_URL is not set — declare `knowledge.redis: { provider: redis }` in astropods.yml');
      })());

export const redis = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 3 });
const subscriber = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 3 });

export type Skill = { name: string; content: string };

export async function listSkills(): Promise<Skill[]> {
  const raw = await redis.hgetall(SKILLS_HASH_KEY);
  return Object.entries(raw)
    .map(([name, content]) => ({ name, content }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function getSkill(name: string): Promise<Skill | null> {
  const content = await redis.hget(SKILLS_HASH_KEY, name);
  return content == null ? null : { name, content };
}

export async function putSkill(name: string, content: string): Promise<void> {
  await redis.hset(SKILLS_HASH_KEY, name, content);
  await redis.publish(SKILLS_CHANNEL, JSON.stringify({ op: 'put', name }));
}

export async function deleteSkill(name: string): Promise<boolean> {
  const removed = await redis.hdel(SKILLS_HASH_KEY, name);
  if (removed > 0) {
    await redis.publish(SKILLS_CHANNEL, JSON.stringify({ op: 'delete', name }));
  }
  return removed > 0;
}

export async function renameSkill(oldName: string, newName: string): Promise<void> {
  const content = await redis.hget(SKILLS_HASH_KEY, oldName);
  if (content == null) throw new Error(`Skill "${oldName}" not found`);

  await redis.hset(SKILLS_HASH_KEY, newName, content);
  await redis.publish(SKILLS_CHANNEL, JSON.stringify({ op: 'put', name: newName }));

  const schedule = await redis.hget(SCHEDULES_HASH_KEY, oldName);
  if (schedule != null) {
    await redis.hset(SCHEDULES_HASH_KEY, newName, schedule);
    await redis.hdel(SCHEDULES_HASH_KEY, oldName);
    await redis.publish(SCHEDULES_CHANNEL, JSON.stringify({ op: 'put', name: newName }));
    await redis.publish(SCHEDULES_CHANNEL, JSON.stringify({ op: 'delete', name: oldName }));
  }

  const lastRun = await redis.hget(LAST_RUN_HASH_KEY, oldName);
  if (lastRun != null) {
    await redis.hset(LAST_RUN_HASH_KEY, newName, lastRun);
    await redis.hdel(LAST_RUN_HASH_KEY, oldName);
  }

  await redis.hdel(SKILLS_HASH_KEY, oldName);
  await redis.publish(SKILLS_CHANNEL, JSON.stringify({ op: 'delete', name: oldName }));
}

export type ChangeEvent = { op: 'put' | 'delete'; name: string };

type ChannelHandlers = Map<string, (event: ChangeEvent) => void>;
const channelHandlers: ChannelHandlers = new Map();

subscriber.on('message', (channel, payload) => {
  const handler = channelHandlers.get(channel);
  if (!handler) return;
  try {
    handler(JSON.parse(payload) as ChangeEvent);
  } catch (err) {
    console.error('[skillit] malformed change payload', channel, payload, err);
  }
});

function subscribeChannel(channel: string, handler: (event: ChangeEvent) => void): void {
  channelHandlers.set(channel, handler);
  subscriber.subscribe(channel).catch((err) => {
    console.error('[skillit] failed to subscribe to', channel, err);
  });
}

export function onSkillsChange(handler: (event: ChangeEvent) => void): void {
  subscribeChannel(SKILLS_CHANNEL, handler);
}

export function onSchedulesChange(handler: (event: ChangeEvent) => void): void {
  subscribeChannel(SCHEDULES_CHANNEL, handler);
}

export type Schedule = {
  cron: string;
  prompt: string;
  tz?: string;
  slackChannel?: string;
};

export type LastRun = {
  ranAt: string;
  durationMs: number;
  output?: string;
  error?: string;
};

export async function listSchedules(): Promise<Record<string, Schedule>> {
  const raw = await redis.hgetall(SCHEDULES_HASH_KEY);
  const out: Record<string, Schedule> = {};
  for (const [name, json] of Object.entries(raw)) {
    try { out[name] = JSON.parse(json) as Schedule; } catch { /* skip malformed */ }
  }
  return out;
}

export async function getSchedule(name: string): Promise<Schedule | null> {
  const json = await redis.hget(SCHEDULES_HASH_KEY, name);
  if (json == null) return null;
  try { return JSON.parse(json) as Schedule; } catch { return null; }
}

export async function putSchedule(name: string, schedule: Schedule): Promise<void> {
  await redis.hset(SCHEDULES_HASH_KEY, name, JSON.stringify(schedule));
  await redis.publish(SCHEDULES_CHANNEL, JSON.stringify({ op: 'put', name }));
}

export async function deleteSchedule(name: string): Promise<boolean> {
  const removed = await redis.hdel(SCHEDULES_HASH_KEY, name);
  if (removed > 0) {
    await redis.publish(SCHEDULES_CHANNEL, JSON.stringify({ op: 'delete', name }));
  }
  return removed > 0;
}

export async function getLastRun(name: string): Promise<LastRun | null> {
  const json = await redis.hget(LAST_RUN_HASH_KEY, name);
  if (json == null) return null;
  try { return JSON.parse(json) as LastRun; } catch { return null; }
}

export async function listLastRuns(): Promise<Record<string, LastRun>> {
  const raw = await redis.hgetall(LAST_RUN_HASH_KEY);
  const out: Record<string, LastRun> = {};
  for (const [name, json] of Object.entries(raw)) {
    try { out[name] = JSON.parse(json) as LastRun; } catch { /* skip malformed */ }
  }
  return out;
}

export async function putLastRun(name: string, run: LastRun): Promise<void> {
  await redis.hset(LAST_RUN_HASH_KEY, name, JSON.stringify(run));
}

export async function deleteLastRun(name: string): Promise<void> {
  await redis.hdel(LAST_RUN_HASH_KEY, name);
}
