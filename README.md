# skillit

_"A claw for your skills."_ 

Drop markdown skill files into the admin UI and each one becomes a callable skill that the agent will route prompts to.

[![Deploy to Astro AI](https://github.com/astropods/agents/blob/main/assets/deploy-button.svg)](https://astropods.com/rabbah/skillit)

## Quick start

```bash
# Install dependencies
bun install

# Set required inputs
ast configure   # prompts for ADMIN_PASSWORD, SESSION_SECRET

# Start the agent locally (also spins up the Redis knowledge container)
ast dev
```

Then open the admin UI at the agent's frontend URL (e.g. `http://localhost`) and
sign in with `ADMIN_PASSWORD`. Upload one or more `.md` files — the filename
(minus extension) becomes the skill name.

## Using the agent

In the chat playground (default `localhost:3100`):

- Ask any question. The agent picks the best matching skill, calls `run_skill`
  to load it, and follows its instructions.
- Prefix a message with `/<skill-name>` to dispatch to a specific skill
  directly (skipping routing). Example: `/recipes what can I make with eggs?`

## Scheduled skills (optional)

Each skill can optionally be attached to a cron schedule from the admin UI:

- Click **Schedule** on a skill, fill in:
  - **Cron expression** — standard 5-field (e.g. `0 9 * * 1-5` for weekdays at 09:00)
  - **Prompt** — the exact text sent to the skill at each fire
  - **Timezone** (optional) — IANA TZ name; defaults to the container's TZ
- Click **Run now** to fire the skill on demand with the saved prompt.
- The most recent run (timestamp, duration, output or error) is shown inline.
  Output is truncated at 8 KiB for display; the full text is logged.

Schedules survive restarts (stored in Redis hash `skillit:schedules`). The
in-process scheduler is rebuilt on Redis pub/sub events, so admin changes take
effect immediately.

Cron fires are routed through the messaging sidecar (same path as chat) by
sending `/<skill-name> <admin-prompt>` with a fresh `conversationId` per fire.
That means scheduled runs get the same tracing/observability as user chats
and reuse the slash-dispatch code path — there is only one execution model
in the agent.

> **Caveat:** the scheduler runs in-process. With multiple agent replicas, the
> same job will fire on each replica. Run a single replica when using
> schedules, or add leader-election before scaling out.

## Bundled example skill

A skill named `example` ships in the image and is seeded on first boot if
Redis is empty. As soon as any user-uploaded skill exists, `example` is
filtered out of routing automatically. Delete it from the admin UI if you
don't want it around.

## Project structure

```
skillit/
├── agent/
│   ├── index.ts            # boot, wiring, Mastra agent, run_skill tool
│   ├── redis.ts            # Redis client, skill + schedule + last-run CRUD, pub/sub
│   ├── skills.ts           # cache, dynamic instructions, tool factory, /slash rewrite
│   ├── dispatch.ts         # AgentAdapter wrapper that handles /slash dispatch
│   ├── scheduler.ts        # node-cron jobs; fires via @astropods/messaging so cron reuses the chat path
│   ├── memory-cleanup.ts   # periodic TTL sweep of stale cron threads from Mastra memory
│   ├── frontend.ts         # Bun.serve admin HTTP server
│   └── static/
│       ├── admin.html      # vanilla admin UI
│       └── example.md      # bundled example skill, seeded on first boot
├── astropods.yml           # declares anthropic model, redis knowledge, frontend interface
├── Dockerfile
└── package.json
```

## Configuration

The agent is configured in `astropods.yml`.

### Inputs

| Input | Required | Description |
|---|---|---|
| `ADMIN_PASSWORD` | yes | Password for the `/admin` upload UI |
| `SESSION_SECRET` | yes | HMAC secret used to sign admin session cookies |

### Integrations

| Integration | Type | Environment variable |
|---|---|---|
| Anthropic | Model API | `ANTHROPIC_API_KEY` |
| Redis | Knowledge container | auto-injected by the platform |

### Interfaces

- **Frontend** — Admin UI served on port 80
- **Web messaging** — Chat playground (`localhost:3100` during dev)

## How dispatch works

- The agent's system prompt is **generated dynamically** on every turn from
  the current set of cached skills, so the model always sees the up-to-date
  list of available skill names + their first-line descriptions.
- The agent has a single tool, `run_skill(skill_name, prompt?)`, which returns
  the markdown content of the named skill. The model is instructed to choose a
  skill, call the tool to load its instructions, then follow them.
- Messages that start with `/<skill-name>` are rewritten by
  `SlashDispatchAdapter` before they reach the model: the skill content is
  inlined into the prompt and the model is told to apply it directly without
  calling the tool. Unknown skills produce a helpful error listing the
  available names.

## How skill refresh works

- Skills live in the Redis hash `skillit:skills` (`name → markdown`).
- Admin writes (upload, delete) publish a small JSON payload on
  `skillit:skills:changes`.
- The agent subscribes to that channel and updates its in-memory cache on
  each event — no per-turn Redis read needed, and changes propagate instantly
  even across multiple agent replicas.
