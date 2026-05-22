import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { listSkills, getSkill, onSkillsChange, type Skill } from './redis';

const cache = new Map<string, string>();
let ready = false;
let readyResolve: () => void;
const readyPromise = new Promise<void>((r) => { readyResolve = r; });

async function reload(): Promise<void> {
  const skills = await listSkills();
  cache.clear();
  for (const s of skills) cache.set(s.name, s.content);
  if (!ready) { ready = true; readyResolve(); }
}

export async function initSkillsCache(): Promise<void> {
  await reload();
  onSkillsChange(async (event) => {
    try {
      if (event.op === 'delete') {
        cache.delete(event.name);
        return;
      }
      const skill = await getSkill(event.name);
      if (skill) cache.set(skill.name, skill.content);
    } catch (err) {
      console.error('[skillit] failed to apply skill change', event, err);
    }
  });
}

export function waitForSkills(): Promise<void> {
  return readyPromise;
}

export function listCached(): Skill[] {
  return [...cache.entries()]
    .map(([name, content]) => ({ name, content }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getCached(name: string): string | undefined {
  return cache.get(name);
}

/**
 * Returns the skills that are "active" for routing. The bundled `example` skill
 * is filtered out as soon as any user-provided skill exists.
 */
export function activeSkills(): Skill[] {
  const all = listCached();
  const userSkills = all.filter((s) => s.name !== 'example');
  return userSkills.length > 0 ? userSkills : all;
}

function firstNonEmptyLine(text: string): string {
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^#+\s*/, '').trim();
    if (line) return line;
  }
  return '';
}

export function renderInstructions(): string {
  const skills = activeSkills();
  const list = skills.length
    ? skills.map((s) => `- \`${s.name}\` — ${firstNonEmptyLine(s.content) || '(no description)'}`).join('\n')
    : '- (no skills loaded — ask the admin to upload some at /admin)';

  return `You are Skillit, a dispatcher agent. Your only job is to route user requests to the right "skill" and follow that skill's instructions to answer.

Available skills:
${list}

How to handle a request:
1. Pick the skill whose description best matches the user's request.
2. Call the \`run_skill\` tool with that skill's name (and optionally a short paraphrased prompt) to load its instructions.
3. Follow the returned skill instructions exactly to produce your answer.
4. If no skill clearly applies, say so plainly and list the available skill names — do not improvise.

If the user begins a message with \`/<skill-name>\`, that is an explicit dispatch. The skill content has already been injected into the prompt for you — apply it directly without calling \`run_skill\`.`;
}

export const runSkillTool = createTool({
  id: 'run_skill',
  description:
    'Load the markdown instructions for a named skill so you can follow them. Call this once per turn after you pick which skill best matches the user request.',
  inputSchema: z.object({
    skill_name: z.string().describe('Exact name of the skill to load (case-sensitive, no extension).'),
    prompt: z.string().optional().describe('Optional paraphrase of the user request, for logging/tracing.'),
  }),
  execute: async ({ skill_name }) => {
    const content = getCached(skill_name);
    if (!content) {
      const available = activeSkills().map((s) => s.name).join(', ') || '(none)';
      return {
        ok: false,
        error: `Skill "${skill_name}" not found. Available skills: ${available}.`,
      };
    }
    return { ok: true, skill_name, instructions: content };
  },
});

/**
 * If `prompt` starts with `/<skill-name>`, return a rewritten prompt that
 * inlines the skill content and tells the LLM to apply it directly. Returns
 * `null` if no slash dispatch was requested.
 */
export function rewriteSlashDispatch(prompt: string): string | null {
  const trimmed = prompt.trimStart();
  if (!trimmed.startsWith('/')) return null;

  const match = trimmed.match(/^\/([A-Za-z0-9_.-]+)\s*([\s\S]*)$/);
  if (!match) return null;

  const skillName = match[1];
  const rest = match[2] ?? '';
  const content = getCached(skillName);

  if (!content) {
    const available = activeSkills().map((s) => s.name).join(', ') || '(none)';
    return `The user invoked the skill \`/${skillName}\` but no such skill is loaded. Tell them: "Unknown skill: ${skillName}. Available skills: ${available}." Do not call any tools.`;
  }

  return `The user explicitly invoked the \`${skillName}\` skill with this input:

${rest.trim() || '(no additional input)'}

The skill's instructions are below. Apply them exactly to the user's input. Do not call \`run_skill\` — the skill is already loaded.

--- begin ${skillName} skill ---
${content}
--- end ${skillName} skill ---`;
}
