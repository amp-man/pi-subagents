# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.1] - 2026-03-09

### Added
- **Live conversation viewer** — selecting a running (or completed) agent in `/agents` → "Running agents" now opens a scrollable overlay showing the agent's full conversation in real time. Auto-scrolls to follow new content; scroll up to pause, End to resume. Press Esc to close.

## [0.3.0] - 2026-03-08

### Added
- **Case-insensitive agent type lookup** — `"explore"`, `"EXPLORE"`, and `"Explore"` all resolve to the same agent. LLMs frequently lowercase type names; this prevents validation failures.
- **Unknown type fallback** — unrecognized agent types fall back to `general-purpose` with a note, instead of hard-rejecting. Matches Claude Code behavior.
- **Dynamic tool list for general-purpose** — `builtinToolNames` is now optional in `AgentConfig`. When omitted, the agent gets all tools from `TOOL_FACTORIES` at lookup time, so new tools added upstream are automatically available.
- **Agent source indicators in `/agents` menu** — `•` (project), `◦` (global), `✕` (disabled) with legend. Defaults are unmarked.
- **Disabled agents visible in UI** — disabled agents now show in the "Agent types" list (marked `✕`) with an Enable action, instead of being invisible.
- **Enable action** — re-enable a disabled agent from the `/agents` menu. Stub files are auto-cleaned.
- **Disable action for all agent types** — custom and ejected default agents can now be disabled from the UI, not just built-in defaults.
- `resolveType()` export — case-insensitive type name resolution for external use.
- `getAllTypes()` export — returns all agent names including disabled (for UI listing).
- `source` field on `AgentConfig` — tracks where an agent was loaded from (`"default"`, `"project"`, `"global"`).

### Fixed
- **Model resolver checks auth for exact matches** — `resolveModel("anthropic/claude-haiku-4-5-20251001")` now fails gracefully when no Anthropic API key is configured, instead of returning a model that errors at the API call. Explore silently falls back to the parent model on non-Anthropic setups.

### Changed
- **Unified agent registry** — built-in and custom agents now use the same `AgentConfig` type and a single registry. No more separate code paths for built-in vs custom agents.
- **Default agents are overridable** — creating a `.md` file with the same name as a default agent (e.g. `.pi/agents/Explore.md`) overrides it.
- **`/agents` menu** — "Agent types" list shows defaults and custom agents together with source indicators. Default agents get Eject/Disable actions; overridden defaults get Reset to default.
- **Eject action** — export a default agent's embedded config as a `.md` file to project or personal location for customization.
- **Model labels** — provider-agnostic: strips `provider/` prefix and `-YYYYMMDD` date suffix (e.g. `anthropic/claude-haiku-4-5-20251001` → `claude-haiku-4-5`). Works for any provider.
- **New frontmatter fields** — `display_name` (UI display name) and `enabled` (default: true; set to false to disable).
- **Menu navigation** — Esc in agent detail returns to agent list (not main menu).

### Removed
- **`statusline-setup` and `claude-code-guide` agents** — removed as built-in types (never spawned programmatically). Users can recreate them as custom agents if needed.
- `BuiltinSubagentType` union type, `SUBAGENT_TYPES` array, `DISPLAY_NAMES` map, `SubagentTypeConfig` interface — replaced by unified `AgentConfig`.
- `buildSystemPrompt()` switch statement — replaced by config-driven `buildAgentPrompt()`.
- `HAIKU_MODEL_IDS` fallback array — Explore's haiku default is now just the `model` field in its config.
- `BUILTIN_MODEL_LABELS` — model labels now derived from config.
- `ALL_TOOLS` hardcoded constant — general-purpose now derives tools dynamically.

### Added
- `src/default-agents.ts` — embedded default configs for general-purpose, Explore, and Plan.

## [0.2.7] - 2026-03-08

### Fixed
- **Widget crash in narrow terminals** — agent widget lines were not truncated to terminal width, causing `doRender` to throw when the tmux pane was narrower than the rendered content. All widget lines are now truncated using `truncateToWidth()` with the actual terminal column count.

## [0.2.6] - 2026-03-07

### Added
- **Background task join strategies** — smart grouping of background agent completion notifications
  - `smart` (default): 2+ background agents spawned in the same turn are auto-grouped into a single consolidated notification instead of individual nudges
  - `async`: each agent notifies individually on completion (previous behavior)
  - `group`: force grouping even for solo agents
  - 30s timeout after first completion delivers partial results; 15s straggler re-batch window for remaining agents
- **`join_mode` parameter** on the `Agent` tool — override join strategy per agent (`"async"` or `"group"`)
- **Join mode setting** in `/agents` → Settings — configure the default join mode at runtime
- New `src/group-join.ts` — `GroupJoinManager` class for batched completion notifications

### Changed
- `AgentRecord` now includes optional `groupId`, `joinMode`, and `resultConsumed` fields
- Background agent completion routing refactored: individual nudge logic extracted to `sendIndividualNudge()`, group delivery via `GroupJoinManager`

### Fixed
- **Debounce window race** — agents that complete during the 100ms batch debounce window are now deferred and retroactively fed into the group once it's registered, preventing split notifications (one individual + one partial group) and zombie groups
- **Solo agent swallowed notification** — if only one agent was spawned (no group formed) but it completed during the debounce window, its deferred notification is now sent when the batch finalizes
- **Duplicate notifications after polling** — calling `get_subagent_result` on a completed agent now marks its result as consumed, suppressing the subsequent completion notification (both individual and group)

## [0.2.5] - 2026-03-06

### Added
- **Interactive `/agents` menu** — single command replaces `/agent` and `/agents` with a full management wizard
  - Browse and manage running agents
  - Custom agents submenu — edit or delete existing agents
  - Create new custom agents via manual wizard or AI-generated (with comprehensive frontmatter documentation for the generator)
  - Settings: configure max concurrency, default max turns, and grace turns at runtime
  - Built-in agent types shown with model info (e.g. `Explore · haiku`)
  - Aligned formatting for agent lists
- **Configurable turn limits** — `defaultMaxTurns` and `graceTurns` are now runtime-adjustable via `/agents` → Settings
- Sub-menus return to main menu instead of exiting

### Removed
- `/agent <type> <prompt>` command (use `Agent` tool directly, or create custom agents via `/agents`)

## [0.2.4] - 2026-03-06

### Added
- **Global custom agents** — agents in `~/.pi/agent/agents/*.md` are now discovered automatically and available across all projects
- Two-tier discovery hierarchy: project-level (`.pi/agents/`) overrides global (`~/.pi/agent/agents/`)

## [0.2.3] - 2026-03-05

### Added
- Screenshot in README

## [0.2.2] - 2026-03-05

### Changed
- Renamed package to `@tintinweb/pi-subagents`
- Fuzzy model resolver now only matches models with auth configured (prevents selecting unconfigured providers)
- Custom agents hot-reload on each `Agent` tool call (no restart needed for new `.pi/agents/*.md` files)
- Updated pi dependencies to 0.56.1

### Refactored
- Extracted `createActivityTracker()` — eliminates duplicated tool activity wiring between foreground and background paths
- Extracted `safeFormatTokens()` — replaces 4 repeated try-catch blocks
- Extracted `buildDetails()` — consolidates AgentDetails construction
- Extracted `getStatusLabel()` / `getStatusNote()` — consolidates 3 duplicated status formatting chains
- Shared `extractText()` — consolidated duplicate from context.ts and agent-runner.ts
- Added `ERROR_STATUSES` constant in widget for consistent status checks
- `getDisplayName()` now delegates to `getConfig()` instead of separate lookups
- Removed unused `Tool` type export from agent-types

## [0.2.1] - 2026-03-05

### Added
- **Persistent above-editor widget** — tree view of all running/queued/finished agents with animated spinners and live stats
- **Concurrency queue** — configurable max concurrent background agents (default: 4), auto-drain
- **Queued agents** collapsed to single summary line in widget
- **Turn-based widget linger** — completed agents clear after 1 turn, errors/aborted linger for 2 extra turns
- **Colored status icons** — themed rendering via `setWidget` callback form (`✓` green, `✓` yellow, `✗` red, `■` dim)
- **Live response streaming** — `onTextDelta` shows truncated agent response text instead of static "thinking..."

### Changed
- Tool names match Claude Code: `Agent`, `get_subagent_result`, `steer_subagent`
- Labels use "Agent" / "Agents" (not "Subagent")
- Widget heading: `●` when active, `○` when only lingering finished agents
- Extracted all UI code to `src/ui/agent-widget.ts`

## [0.2.0] - 2026-03-05

### Added
- **Claude Code-style UI rendering** — `renderCall`/`renderResult`/`onUpdate` for live streaming progress
  - Live activity descriptions: "searching, reading 3 files…"
  - Token count display: "33.8k tokens"
  - Per-agent tool use counter
  - Expandable completed results (ctrl+o)
  - Distinct states: running, background, completed, error, aborted
- **Async environment detection** — replaced `execSync` with `pi.exec()` for non-blocking git/platform detection
- **Status bar integration** — running background agent count shown in pi's status bar
- **Fuzzy model selection** — `"haiku"`, `"sonnet"` resolve to best matching available model

### Changed
- Tool label changed from "Spawn Agent" to "Agent" (matches Claude Code style)
- `onToolUse` callback replaced with richer `onToolActivity` (includes tool name + start/end)
- `onSessionCreated` callback for accessing session stats (token counts)
- `env.ts` now requires `ExtensionAPI` parameter (async `pi.exec()` instead of `execSync`)

## [0.1.0] - 2026-03-05

Initial release.

### Added
- **Autonomous sub-agents** — spawn specialized agents via tool call, each running in an isolated pi session
- **Built-in agent types** — general-purpose, Explore (defaults to haiku), Plan, statusline-setup, claude-code-guide
- **Custom user-defined agents** — define agents in `.pi/agents/<name>.md` with YAML frontmatter + system prompt body
- **Frontmatter configuration** — tools, extensions, skills, model, thinking, max_turns, prompt_mode, inherit_context, run_in_background, isolated
- **Graceful max_turns** — steer message at limit, 5 grace turns, then hard abort
- **Background execution** — `run_in_background` with completion notifications
- **`get_subagent_result` tool** — check status, wait for completion, verbose conversation output
- **`steer_subagent` tool** — inject steering messages into running agents mid-execution
- **Agent resume** — continue a previous agent's session with a new prompt
- **Context inheritance** — fork the parent conversation into the sub-agent
- **Model override** — per-agent model selection
- **Thinking level** — per-agent extended thinking control
- **`/agent` and `/agents` commands**

[0.3.0]: https://github.com/tintinweb/pi-subagents/compare/v0.2.7...v0.3.0
[0.2.7]: https://github.com/tintinweb/pi-subagents/compare/v0.2.6...v0.2.7
[0.2.6]: https://github.com/tintinweb/pi-subagents/compare/v0.2.5...v0.2.6
[0.2.5]: https://github.com/tintinweb/pi-subagents/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/tintinweb/pi-subagents/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/tintinweb/pi-subagents/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/tintinweb/pi-subagents/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/tintinweb/pi-subagents/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/tintinweb/pi-subagents/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/tintinweb/pi-subagents/releases/tag/v0.1.0
