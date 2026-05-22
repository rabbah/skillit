---
description: Generic dispatcher agent that loads admin-uploaded markdown skill files from Redis, routes user prompts to them, and runs them on per-skill cron schedules with optional Slack posting.
tags:
  - dispatcher
  - skills
  - redis
  - cron
  - slack
  - mastra
  - anthropic
  - web-search
authors:
  - name: Rodric Rabbah
    account: rabbah
capabilities:
  - Serves a password-gated admin UI at /admin for managing markdown skill files
  - Stores skill files in Redis and refreshes an in-process cache via Redis pub/sub on admin changes
  - Exposes a run_skill tool the LLM calls to load the matching skill's instructions
  - Supports explicit /skill-name dispatch in chat messages to bypass LLM routing
  - Lets admins attach a per-skill cron schedule with an optional prompt and Slack channel
  - Posts scheduled run output to an admin-configured Slack channel via the platform Slack adapter
  - Persists each schedule's last run to Redis and surfaces it inline in the admin UI
  - Sweeps stale cron-fired conversations from Mastra memory hourly with a 24h TTL
  - Optionally exposes a web_search tool (powered by Tavily) for skills that need live web results
repository: github:rabbah/skillit
integrations:
  - Anthropic
  - Redis
  - Slack
  - Mastra
  - Tavily (optional)
---

## Overview

`skillit` is a generic dispatcher agent. Operators upload markdown files via
the admin UI; each filename becomes the name of a "skill" whose content is
treated as the system instructions for handling matching user requests. The
agent loads skills from Redis at boot, refreshes its in-process cache via
pub/sub on admin changes, and either routes a user message to the
best-matching skill via the `run_skill` tool or executes an explicitly-named
skill when the user prefixes their message with `/<skill-name>`.

Each skill can optionally be scheduled to run on cron, with the agent
invoked in-process via `agent.generate()` and the result persisted to Redis
(and posted to a Slack channel if one is configured on the schedule).

## Usage

### Adding and editing skills

Sign into `/admin` with `ADMIN_PASSWORD`. Drag-and-drop one or more `.md`,
`.markdown`, or `.txt` files into the upload area; the filename (minus
extension) becomes the skill name. Existing skills can be deleted from the
same view. Changes propagate to the agent's in-process cache immediately
via Redis pub/sub — no restart required.

A bundled `example` skill is seeded on first boot if Redis is empty and is
auto-filtered from routing once any user-uploaded skill exists.

### Chatting with the agent

In any messaging adapter (web playground, Slack channel where the bot is
installed, etc.):

- Ask a question. The LLM picks the best matching skill from the dynamic
  system prompt, calls `run_skill` to load it, then follows the loaded
  instructions.
- Prefix a message with `/<skill-name>` to dispatch directly, skipping LLM
  routing. The skill content is inlined into the prompt and applied as-is.

### Scheduling skills

For each skill, click **Schedule** in the admin UI and provide:

- **Cron expression** — a standard 5-field expression (e.g. `0 9 * * 1-5`).
- **Prompt** (optional) — sent as the user input to the skill on each fire.
  Leave blank to fire the skill with no additional input.
- **Timezone** (optional) — IANA TZ name; defaults to the container's TZ.
- **Slack channel** (optional) — a Slack channel ID (`C0123456789`) to post
  the run's output to. Requires the platform's Slack adapter to be
  configured separately; the bot must be a member of the target channel.

The most recent run for each schedule is shown inline (timestamp, duration,
output or error). Use the **Run now** button to fire a schedule on demand.

### Web search

Skills can use the `web_search` tool to fetch live results from the web via
[Tavily](https://app.tavily.com). The tool is only available when
`TAVILY_API_KEY` is set — if it is not configured, the tool is silently
omitted and skills that reference it will fall back to the model's training
data.

To enable it, set `TAVILY_API_KEY` while deploying the agent blueprint.

### Inputs

| Input | Required | Description |
|---|---|---|
| `ADMIN_PASSWORD` | yes | Password gating the `/admin` upload UI |
| `SESSION_SECRET` | yes | HMAC secret used to sign admin session cookies |
| `TAVILY_API_KEY` | no | Tavily API key for web search; if omitted, `web_search` is disabled |

## Limitations

- **Single replica only.** The scheduler runs in-process; with multiple
  replicas the same cron job fires on each.
- **Mastra memory is in-process.** Each cron fire creates a fresh thread
  in `LibSQLStore({ url: ':memory:' })`. An hourly sweep deletes threads
  older than 24h, but they don't survive a process restart.
- **No history of cron runs.** Only the most recent run per schedule is
  persisted in Redis (`skillit:last-run`). Older runs are overwritten.
- **Slack posting requires the bot to be in the target channel.** Posts
  to channels the bot isn't a member of are silently dropped with
  `not_in_channel`. Use the channel ID (e.g. `C0123456789`), not the
  channel name.
- **Session storage is ephemeral.** Admin sessions are HMAC-signed
  cookies — they survive process restarts only if `SESSION_SECRET` is
  set to a stable value (otherwise an ephemeral secret is generated and
  sessions reset on restart).
- **Output truncation.** Cron run output is truncated at 8 KiB for
  Redis storage and ~35 KB for Slack posts.
