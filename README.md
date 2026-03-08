# @tintinweb/pi-subagents

A [pi](https://pi.dev) extension that brings **Claude Code-style autonomous sub-agents** to pi. Spawn specialized agents that run in isolated sessions — each with its own tools, system prompt, model, and thinking level. Run them in foreground or background, steer them mid-run, resume completed sessions, and define your own custom agent types.

> **Status:** Early release.

<img width="600" alt="pi-subagents screenshot" src="https://github.com/tintinweb/pi-subagents/raw/master/media/screenshot.png" />


https://github.com/user-attachments/assets/5d1331e8-6d02-420b-b30a-dcbf838b1660


## Features

- **Claude Code look & feel** — same tool names, calling conventions, and UI patterns (`Agent`, `get_subagent_result`, `steer_subagent`) — feels native
- **Parallel background agents** — spawn multiple agents that run concurrently with automatic queuing (configurable concurrency limit, default 4) and smart group join (consolidated notifications)
- **Live widget UI** — persistent above-editor widget with animated spinners, live tool activity, token counts, and colored status icons
- **Custom agent types** — define agents in `.pi/agents/<name>.md` with YAML frontmatter: custom system prompts, model selection, thinking levels, tool restrictions
- **Mid-run steering** — inject messages into running agents to redirect their work without restarting
- **Session resume** — pick up where an agent left off, preserving full conversation context
- **Graceful turn limits** — agents get a "wrap up" warning before hard abort, producing clean partial results instead of cut-off output
- **Case-insensitive agent types** — `"explore"`, `"Explore"`, `"EXPLORE"` all work. Unknown types fall back to general-purpose with a note
- **Fuzzy model selection** — specify models by name (`"haiku"`, `"sonnet"`) instead of full IDs, with automatic filtering to only available/configured models
- **Context inheritance** — optionally fork the parent conversation into a sub-agent so it knows what's been discussed

## Install

```bash
pi install npm:@tintinweb/pi-subagents
```

Or load directly for development:

```bash
pi -e ./src/index.ts
```

## Quick Start

The parent agent spawns sub-agents using the `Agent` tool:

```
Agent({
  subagent_type: "Explore",
  prompt: "Find all files that handle authentication",
  description: "Find auth files",
  run_in_background: true,
})
```

Foreground agents block until complete and return results inline. Background agents return an ID immediately and notify you on completion.

## UI

The extension renders a persistent widget above the editor showing all active agents:

```
● Agents
├─ ⠹ Agent  Refactor auth module · 5 tool uses · 33.8k tokens · 12.3s
│    ⎿  editing 2 files…
├─ ⠹ Explore  Find auth files · 3 tool uses · 12.4k tokens · 4.1s
│    ⎿  searching…
└─ 2 queued
```

Individual agent results render Claude Code-style in the conversation:

| State | Example |
|-------|---------|
| **Running** | `⠹ 3 tool uses · 12.4k tokens` / `⎿ searching, reading 3 files…` |
| **Completed** | `✓ 5 tool uses · 33.8k tokens · 12.3s` / `⎿ Done` |
| **Wrapped up** | `✓ 50 tool uses · 89.1k tokens · 45.2s` / `⎿ Wrapped up (turn limit)` |
| **Stopped** | `■ 3 tool uses · 12.4k tokens` / `⎿ Stopped` |
| **Error** | `✗ 3 tool uses · 12.4k tokens` / `⎿ Error: timeout` |
| **Aborted** | `✗ 55 tool uses · 102.3k tokens` / `⎿ Aborted (max turns exceeded)` |

Completed results can be expanded (ctrl+o in pi) to show the full agent output inline.

## Default Agent Types

| Type | Tools | Model | Description |
|------|-------|-------|-------------|
| `general-purpose` | all 7 | inherit | Full read/write access for complex multi-step tasks |
| `Explore` | read, bash, grep, find, ls | haiku (falls back to inherit) | Fast codebase exploration (read-only) |
| `Plan` | read, bash, grep, find, ls | inherit | Software architect for implementation planning (read-only) |

Default agents can be **overridden** by creating a `.md` file with the same name (e.g. `.pi/agents/Explore.md`), or **disabled** per-project by creating a `.md` file with `enabled: false` frontmatter.

## Custom Agents

Define custom agent types by creating `.md` files. The filename becomes the agent type name. Any name is allowed — using a default agent's name overrides it.

Agents are discovered from two locations (higher priority wins):

| Priority | Location | Scope |
|----------|----------|-------|
| 1 (highest) | `.pi/agents/<name>.md` | Project — per-repo agents |
| 2 | `~/.pi/agent/agents/<name>.md` | Global — available everywhere |

Project-level agents override global ones with the same name, so you can customize a global agent for a specific project.

### Example: `.pi/agents/auditor.md`

```markdown
---
description: Security Code Reviewer
tools: read, grep, find, bash
model: anthropic/claude-opus-4-6
thinking: high
max_turns: 30
---

You are a security auditor. Review code for vulnerabilities including:
- Injection flaws (SQL, command, XSS)
- Authentication and authorization issues
- Sensitive data exposure
- Insecure configurations

Report findings with file paths, line numbers, severity, and remediation advice.
```

Then spawn it like any built-in type:

```
Agent({ subagent_type: "auditor", prompt: "Review the auth module", description: "Security audit" })
```

### Frontmatter Fields

All fields are optional — sensible defaults for everything.

| Field | Default | Description |
|-------|---------|-------------|
| `description` | filename | Agent description shown in tool listings |
| `display_name` | — | Display name for UI (e.g. widget, agent list) |
| `tools` | all 7 | Comma-separated built-in tools: read, bash, edit, write, grep, find, ls. `none` for no tools |
| `extensions` | `true` | Inherit MCP/extension tools. `false` to disable |
| `skills` | `true` | Inherit skills from parent |
| `model` | inherit parent | Model — `provider/modelId` or fuzzy name (`"haiku"`, `"sonnet"`) |
| `thinking` | inherit | off, minimal, low, medium, high, xhigh |
| `max_turns` | 50 | Max agentic turns before graceful shutdown |
| `prompt_mode` | `replace` | `replace`: body is the full system prompt. `append`: body appended to default prompt |
| `inherit_context` | `false` | Fork parent conversation into agent |
| `run_in_background` | `false` | Run in background by default |
| `isolated` | `false` | No extension/MCP tools, only built-in |
| `enabled` | `true` | Set to `false` to disable an agent (useful for hiding a default agent per-project) |

Frontmatter sets defaults. Explicit `Agent` parameters always override them.

## Tools

### `Agent`

Launch a sub-agent.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `prompt` | string | yes | The task for the agent |
| `description` | string | yes | Short 3-5 word summary (shown in UI) |
| `subagent_type` | string | yes | Agent type (built-in or custom) |
| `model` | string | no | Model — `provider/modelId` or fuzzy name (`"haiku"`, `"sonnet"`) |
| `thinking` | string | no | Thinking level: off, minimal, low, medium, high, xhigh |
| `max_turns` | number | no | Max agentic turns (default: 50) |
| `run_in_background` | boolean | no | Run without blocking |
| `resume` | string | no | Agent ID to resume a previous session |
| `isolated` | boolean | no | No extension/MCP tools |
| `inherit_context` | boolean | no | Fork parent conversation into agent |
| `join_mode` | `"async"` \| `"group"` | no | Override join strategy for background completion notifications (default: smart) |

### `get_subagent_result`

Check status and retrieve results from a background agent.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `agent_id` | string | yes | Agent ID to check |
| `wait` | boolean | no | Wait for completion |
| `verbose` | boolean | no | Include full conversation log |

### `steer_subagent`

Send a steering message to a running agent. The message interrupts after the current tool execution.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `agent_id` | string | yes | Agent ID to steer |
| `message` | string | yes | Message to inject into agent conversation |

## Commands

| Command | Description |
|---------|-------------|
| `/agents` | Interactive agent management menu |

The `/agents` command opens an interactive menu:

```
Running agents (2) — 1 running, 1 done     ← only shown when agents exist
Agent types (6)                             ← unified list: defaults + custom
Create new agent                            ← manual wizard or AI-generated
Settings                                    ← max concurrency, max turns, grace turns, join mode
```

- **Agent types** — unified list with source indicators: `•` (project), `◦` (global), `✕` (disabled). Select an agent to manage it:
  - **Default agents** (no override): Eject (export as `.md`), Disable
  - **Default agents** (ejected/overridden): Edit, Disable, Reset to default, Delete
  - **Custom agents**: Edit, Disable, Delete
  - **Disabled agents**: Enable, Edit, Delete
- **Eject** — writes the embedded default config as a `.md` file to project or personal location, so you can customize it
- **Disable/Enable** — toggle agent availability. Disabled agents stay visible in the list (marked `✕`) and can be re-enabled
- **Create new agent** — choose project/personal location, then manual wizard (step-by-step prompts for name, tools, model, thinking, system prompt) or AI-generated (describe what the agent should do and a sub-agent writes the `.md` file). Any name is allowed, including default agent names (overrides them)
- **Settings** — configure max concurrency, default max turns, grace turns, and join mode at runtime

## Graceful Max Turns

Instead of hard-aborting at the turn limit, agents get a graceful shutdown:

1. At `max_turns` — steering message: *"Wrap up immediately — provide your final answer now."*
2. Up to 5 grace turns to finish cleanly
3. Hard abort only after the grace period

| Status | Meaning | Icon |
|--------|---------|------|
| `completed` | Finished naturally | `✓` green |
| `steered` | Hit limit, wrapped up in time | `✓` yellow |
| `aborted` | Grace period exceeded | `✗` red |
| `stopped` | User-initiated abort | `■` dim |

## Concurrency

Background agents are subject to a configurable concurrency limit (default: 4). Excess agents are automatically queued and start as running agents complete. The widget shows queued agents as a collapsed count.

Foreground agents bypass the queue — they block the parent anyway.

## Join Strategies

When background agents complete, they notify the main agent. The **join mode** controls how these notifications are delivered:

| Mode | Behavior |
|------|----------|
| `smart` (default) | 2+ background agents spawned in the same turn are auto-grouped into a single consolidated notification. Solo agents notify individually. |
| `async` | Each agent sends its own notification on completion (original behavior). Best when results need incremental processing. |
| `group` | Force grouping even when spawning a single agent. Useful when you know more agents will follow. |

**Timeout behavior:** When agents are grouped, a 30-second timeout starts after the first agent completes. If not all agents finish in time, a partial notification is sent with completed results and remaining agents continue with a shorter 15-second re-batch window for stragglers.

**Configuration:**
- Per-call: `Agent({ ..., join_mode: "async" })` overrides for that agent
- Global default: `/agents` → Settings → Join mode

## Architecture

```
src/
  index.ts            # Extension entry: tool/command registration, rendering
  types.ts            # Type definitions (AgentConfig, AgentRecord, etc.)
  default-agents.ts   # Embedded default agent configs (general-purpose, Explore, Plan)
  agent-types.ts      # Unified agent registry (defaults + user), tool factories
  agent-runner.ts     # Session creation, execution, graceful max_turns, steer/resume
  agent-manager.ts    # Agent lifecycle, concurrency queue, completion notifications
  group-join.ts       # Group join manager: batched completion notifications with timeout
  custom-agents.ts    # Load user-defined agents from .pi/agents/*.md
  prompts.ts          # Config-driven system prompt builder
  context.ts          # Parent conversation context for inherit_context
  env.ts              # Environment detection (git, platform)
  ui/
    agent-widget.ts   # Persistent widget: spinners, activity, status icons, theming
```

## License

MIT — [tintinweb](https://github.com/tintinweb)
