/**
 * skillit — generic agent that dispatches user prompts to admin-uploaded
 * skill files stored in Redis.
 *
 * Environment variables (set via astropods.yml inputs / `ast configure`):
 *   ANTHROPIC_API_KEY          - injected by the anthropic model
 *   GRPC_SERVER_ADDR           - injected by the Astropods messaging service
 *   REDIS_URL                  - injected by the redis knowledge container
 *   ADMIN_PASSWORD             - password gating the /admin upload UI
 *   SESSION_SECRET             - HMAC secret used to sign admin session cookies
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import { Memory } from '@mastra/memory';
import { LibSQLStore } from '@mastra/libsql';
import { Observability } from '@mastra/observability';
import { OtelExporter } from '@mastra/otel-exporter';
import { MastraAdapter } from '@astropods/adapter-mastra';
import { serve } from '@astropods/adapter-core';
import { initSkillsCache, renderInstructions, runSkillTool } from './skills';
import { init as initWebSearch, webSearchTool } from './web-search';
import { putSkill, listSkills } from './redis';
import { SlashDispatchAdapter } from './dispatch';
import { startFrontend } from './frontend';
import { initScheduler } from './scheduler';
import { startCronMemoryCleanup } from './memory-cleanup';

function resolveOtlpTracesEndpoint(): string {
  const raw = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318';
  try {
    const url = new URL(raw);
    if (!url.pathname || url.pathname === '/') url.pathname = '/v1/traces';
    return url.toString();
  } catch {
    return `${raw.replace(/\/+$/, '')}/v1/traces`;
  }
}

async function seedExampleSkillIfEmpty(): Promise<void> {
  const existing = await listSkills();
  if (existing.length > 0) return;
  const here = dirname(fileURLToPath(import.meta.url));
  const content = readFileSync(join(here, 'static', 'example.md'), 'utf8');
  await putSkill('example', content);
  console.log('[skillit] seeded bundled "example" skill (Redis was empty)');
}

await seedExampleSkillIfEmpty();
await initSkillsCache();

const memory = new Memory({
  storage: new LibSQLStore({ id: 'memory', url: ':memory:' }),
});

startCronMemoryCleanup(memory);

const observability = new Observability({
  configs: {
    otel: {
      serviceName: 'skillit',
      exporters: [
        new OtelExporter({
          provider: {
            custom: {
              endpoint: resolveOtlpTracesEndpoint(),
              protocol: 'http/protobuf',
            },
          },
        }),
      ],
    },
  },
});

const agent = new Agent({
  id: 'skillit',
  name: 'Skillit',
  instructions: () => renderInstructions(),
  model: 'anthropic/claude-sonnet-4-5',
  memory,
  tools: { run_skill: runSkillTool, ...(initWebSearch() ? { web_search: webSearchTool } : {}) },
  defaultOptions: {
    tracingOptions: {
      tags: ['astro', 'agent:skillit'],
      metadata: { agent_id: 'skillit' },
    },
  },
});

new Mastra({
  agents: { skillit: agent },
  observability,
});

await initScheduler(agent);

startFrontend();

serve(new SlashDispatchAdapter(new MastraAdapter(agent)));
