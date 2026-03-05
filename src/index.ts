/**
 * pi-claude-subagents — A pi extension providing Claude Code-style autonomous sub-agents.
 *
 * Tools:
 *   spawn_agent       — LLM-callable: spawn a sub-agent
 *   get_agent_result  — LLM-callable: check background agent status/result
 *   steer_agent       — LLM-callable: send a steering message to a running agent
 *
 * Commands:
 *   /agent <type> <prompt>  — User-invocable agent spawning
 *   /agents                 — List all agents with status
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { AgentManager } from "./agent-manager.js";
import { steerAgent, getAgentConversation } from "./agent-runner.js";
import { DISPLAY_NAMES, SUBAGENT_TYPES, type SubagentType, type ThinkingLevel, type CustomAgentConfig } from "./types.js";
import { getConfig, getAvailableTypes, getCustomAgentNames, getCustomAgentConfig, isValidType, registerCustomAgents } from "./agent-types.js";
import { loadCustomAgents } from "./custom-agents.js";

// ---- Types for custom rendering ----

/** Braille spinner frames for animated running indicator. */
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Metadata attached to spawn_agent tool results for custom rendering. */
interface AgentDetails {
  displayName: string;
  description: string;
  subagentType: string;
  toolUses: number;
  tokens: string;
  durationMs: number;
  status: "running" | "completed" | "steered" | "aborted" | "stopped" | "error" | "background";
  /** Human-readable description of what the agent is currently doing. */
  activity?: string;
  /** Current spinner frame index (for animated running indicator). */
  spinnerFrame?: number;
  agentId?: string;
  error?: string;
}

/** Format a token count as "33.8k tokens" or "1.2M tokens". */
function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M tokens`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k tokens`;
  return `${count} tokens`;
}

/** TOOL_DISPLAY_NAMES for activity descriptions. */
const TOOL_DISPLAY: Record<string, string> = {
  read: "reading",
  bash: "running command",
  edit: "editing",
  write: "writing",
  grep: "searching",
  find: "finding files",
  ls: "listing",
};

/** Build a human-readable activity string from currently-running tools. */
function describeActivity(activeTools: Map<string, string>): string {
  if (activeTools.size === 0) return "";

  // Group by action type
  const groups = new Map<string, number>();
  for (const toolName of activeTools.values()) {
    const action = TOOL_DISPLAY[toolName] ?? toolName;
    groups.set(action, (groups.get(action) ?? 0) + 1);
  }

  const parts: string[] = [];
  for (const [action, count] of groups) {
    if (count > 1) {
      parts.push(`${action} ${count} ${action === "searching" ? "patterns" : "files"}`);
    } else {
      parts.push(action);
    }
  }
  return parts.join(", ") + "…";
}

// ---- Shared helpers ----

/** Tool execute return value for a text response. */
function textResult(msg: string, details?: AgentDetails) {
  return { content: [{ type: "text" as const, text: msg }], details: details as any };
}

/** Get display name for any agent type (built-in or custom). */
function getDisplayName(type: SubagentType): string {
  if (type in DISPLAY_NAMES) return DISPLAY_NAMES[type as keyof typeof DISPLAY_NAMES];
  const custom = getCustomAgentConfig(type);
  return custom?.name ?? type;
}

/** Format milliseconds as human-readable duration. */
function formatMs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Format duration from an AgentRecord. */
function formatDuration(startedAt: number, completedAt?: number): string {
  if (completedAt) return formatMs(completedAt - startedAt);
  return `${formatMs(Date.now() - startedAt)} (running)`;
}

/** Resolve system prompt overrides from a custom agent config. */
function resolveCustomPrompt(config: CustomAgentConfig | undefined): {
  systemPromptOverride?: string;
  systemPromptAppend?: string;
} {
  if (!config?.systemPrompt) return {};
  if (config.promptMode === "append") return { systemPromptAppend: config.systemPrompt };
  return { systemPromptOverride: config.systemPrompt };
}

/**
 * Resolve a model string to a Model instance.
 * Tries exact match first ("provider/modelId"), then fuzzy match against all available models.
 * Returns the Model on success, or an error message string on failure.
 */
function resolveModel(
  input: string,
  registry: { find(provider: string, modelId: string): any; getAll(): any[] },
): any | string {
  // 1. Exact match: "provider/modelId"
  const slashIdx = input.indexOf("/");
  if (slashIdx !== -1) {
    const provider = input.slice(0, slashIdx);
    const modelId = input.slice(slashIdx + 1);
    const found = registry.find(provider, modelId);
    if (found) return found;
  }

  // 2. Fuzzy match against all models
  const all = registry.getAll() as { id: string; name: string; provider: string }[];
  const query = input.toLowerCase();

  // Score each model: prefer exact id match > id contains > name contains > provider+id contains
  let bestMatch: typeof all[number] | undefined;
  let bestScore = 0;

  for (const m of all) {
    const id = m.id.toLowerCase();
    const name = m.name.toLowerCase();
    const full = `${m.provider}/${m.id}`.toLowerCase();

    let score = 0;
    if (id === query || full === query) {
      score = 100; // exact
    } else if (id.includes(query) || full.includes(query)) {
      score = 60 + (query.length / id.length) * 30; // substring, prefer tighter matches
    } else if (name.includes(query)) {
      score = 40 + (query.length / name.length) * 20;
    } else if (query.split(/[\s\-/]+/).every(part => id.includes(part) || name.includes(part) || m.provider.toLowerCase().includes(part))) {
      score = 20; // all parts present somewhere
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = m;
    }
  }

  if (bestMatch && bestScore >= 20) {
    const found = registry.find(bestMatch.provider, bestMatch.id);
    if (found) return found;
  }

  // 3. No match — list available models
  const available = all
    .map(m => `  ${m.provider}/${m.id}`)
    .sort()
    .join("\n");
  return `Model not found: "${input}".\n\nAvailable models:\n${available}`;
}

export default function (pi: ExtensionAPI) {
  // Load custom agents from .pi/agents/*.md at init
  const customAgents = loadCustomAgents(process.cwd());
  registerCustomAgents(customAgents);

  const allTypes = getAvailableTypes();
  const customNames = getCustomAgentNames();

  // Status bar: show count of running background agents
  let statusCtx: { setStatus(key: string, text: string | undefined): void } | undefined;
  pi.on("tool_execution_start", async (_event, ctx) => {
    statusCtx = ctx.ui;
  });

  function updateAgentStatus() {
    const running = manager.listAgents().filter(a => a.status === "running");
    if (!statusCtx) return;
    if (running.length === 0) {
      statusCtx.setStatus("subagents", undefined);
    } else {
      const descriptions = running.map(a => a.description).join(", ");
      statusCtx.setStatus("subagents", `${running.length} agent(s) running: ${descriptions}`);
    }
  }

  // Background completion: push notification into conversation
  const manager = new AgentManager((record) => {
    const displayName = getDisplayName(record.type);
    const duration = formatDuration(record.startedAt, record.completedAt);

    const status = record.status === "error"
      ? `Error: ${record.error}`
      : record.status === "aborted"
        ? "Aborted (max turns exceeded)"
        : record.status === "steered"
          ? "Wrapped up (turn limit)"
          : record.status === "stopped"
            ? "Stopped"
            : "Done";

    pi.sendMessage(
      {
        customType: "agent-notification",
        content: [
          {
            type: "text",
            text:
              `Background agent completed: ${displayName} (${record.description})\n` +
              `Agent ID: ${record.id} | Status: ${status} | Tool uses: ${record.toolUses} | Duration: ${duration}\n\n` +
              (record.result
                ? record.result.length > 500
                  ? record.result.slice(0, 500) + "\n...(truncated, use get_agent_result for full output)"
                  : record.result
                : "No output."),
          },
        ],
        display: true,
      },
      { triggerTurn: false },
    );
    updateAgentStatus();
  });

  // Build type descriptions for the tool description
  const builtinDescs = [
    "- general-purpose: Full tool access for complex multi-step tasks.",
    "- Explore: Fast codebase exploration (read-only, defaults to haiku).",
    "- Plan: Software architect for implementation planning (read-only).",
    "- statusline-setup: Configuration editor (read + edit only).",
    "- claude-code-guide: Documentation and help queries (read-only).",
  ];

  const customDescs = customNames.map((name) => {
    const cfg = getCustomAgentConfig(name);
    return `- ${name}: ${cfg?.description ?? name}`;
  });

  const typeListText = [
    "Built-in types:",
    ...builtinDescs,
    ...(customDescs.length > 0 ? ["", "Custom types:", ...customDescs] : []),
  ].join("\n");

  // ---- spawn_agent tool ----

  pi.registerTool<any, AgentDetails>({
    name: "spawn_agent",
    label: "Agent",
    description: `Launch a new agent to handle complex, multi-step tasks autonomously.

Available agent types:
${typeListText}

Guidelines:
- Launch multiple agents concurrently for independent tasks (make multiple spawn_agent calls in one response).
- Use Explore for codebase searches and code understanding.
- Use Plan for architecture and implementation planning.
- Use general-purpose for complex tasks that need file editing.
- Provide clear, detailed prompts with all necessary context — agents start fresh with no parent context by default.
- Set inherit_context to true if the agent needs to understand the conversation so far.
- Agent results are returned as text — summarize them for the user.
- Use run_in_background for work you don't need immediately. You will be notified when it completes. Use get_agent_result to retrieve full results.
- Use resume with an agent ID to continue a previous agent's work.
- Use steer_agent to send mid-run messages to a running background agent.
- Use model to specify a different model (as "provider/modelId").
- Use thinking to control extended thinking level.`,
    parameters: Type.Object({
      prompt: Type.String({
        description: "The task for the agent to perform. Be clear and detailed — agents have no parent context unless inherit_context is set.",
      }),
      description: Type.String({
        description: "A short 3-5 word summary of the task (shown in UI).",
      }),
      subagent_type: Type.String({
        description: `Agent type. Built-in: ${SUBAGENT_TYPES.join(", ")}. ${customNames.length > 0 ? `Custom: ${customNames.join(", ")}.` : "No custom agents defined."}`,
      }),
      model: Type.Optional(
        Type.String({
          description:
            'Model as "provider/modelId" (e.g. "anthropic/claude-sonnet-4-5-20250514"). If omitted, Explore defaults to haiku; others inherit from parent.',
        }),
      ),
      thinking: Type.Optional(
        Type.String({
          description: "Thinking level (e.g. off, minimal, low, medium, high, xhigh). Overrides agent default.",
        }),
      ),
      max_turns: Type.Optional(
        Type.Number({
          description: "Maximum number of agentic turns (API round-trips) before stopping.",
          minimum: 1,
        }),
      ),
      run_in_background: Type.Optional(
        Type.Boolean({
          description: "Set to true to run in background. Returns agent ID immediately. You will be notified on completion.",
        }),
      ),
      resume: Type.Optional(
        Type.String({
          description: "Agent ID to resume. Continues from previous context — the new prompt is sent to the existing session.",
        }),
      ),
      isolated: Type.Optional(
        Type.Boolean({
          description: "If true, agent gets no extension/MCP tools — only built-in tools.",
        }),
      ),
      inherit_context: Type.Optional(
        Type.Boolean({
          description: "If true, the agent receives the parent conversation history as context (like a fork). Default: false (fresh context).",
        }),
      ),
    }),

    // ---- Custom rendering: Claude Code style ----

    renderCall(args, theme) {
      const displayName = getDisplayName(args.subagent_type);
      const spinner = theme.fg("accent", SPINNER[0]);
      const text = spinner + " " + theme.fg("toolTitle", theme.bold(displayName)) + "  " + theme.fg("muted", args.description);
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      const details = result.details as AgentDetails | undefined;
      if (!details) {
        const text = result.content[0]?.type === "text" ? result.content[0].text : "";
        return new Text(text, 0, 0);
      }

      // ---- While running (streaming) ----
      if (isPartial || details.status === "running") {
        const frame = SPINNER[details.spinnerFrame ?? 0];
        let line = theme.fg("accent", frame) + " " + theme.fg("toolTitle", details.description);
        if (details.toolUses > 0) {
          line += " " + theme.fg("dim", "·") + " " + theme.fg("dim", `${details.toolUses} tool use${details.toolUses === 1 ? "" : "s"}`);
        }
        if (details.tokens) {
          line += " " + theme.fg("dim", "·") + " " + theme.fg("dim", details.tokens);
        }
        if (details.activity) {
          line += "\n" + theme.fg("dim", `   ⎿  ${details.activity}`);
        }
        return new Text(line, 0, 0);
      }

      // ---- Background agent launched ----
      if (details.status === "background") {
        const frame = SPINNER[details.spinnerFrame ?? 0];
        let line = theme.fg("accent", frame) + " " + theme.fg("toolTitle", details.description);
        line += "\n" + theme.fg("dim", `   ⎿  Running in background (ID: ${details.agentId})`);
        return new Text(line, 0, 0);
      }

      // ---- Completed / Steered ----
      if (details.status === "completed" || details.status === "steered") {
        const duration = formatMs(details.durationMs);
        const isSteered = details.status === "steered";
        const icon = isSteered ? theme.fg("warning", "✓") : theme.fg("success", "✓");
        let line = icon + " " + theme.fg("toolTitle", details.description);
        line += " " + theme.fg("dim", "·") + " " + theme.fg("dim", `${details.toolUses} tool use${details.toolUses === 1 ? "" : "s"}`);
        if (details.tokens) {
          line += " " + theme.fg("dim", "·") + " " + theme.fg("dim", details.tokens);
        }
        line += " " + theme.fg("dim", "·") + " " + theme.fg("dim", duration);

        if (expanded) {
          const resultText = result.content[0]?.type === "text" ? result.content[0].text : "";
          if (resultText) {
            const lines = resultText.split("\n").slice(0, 50);
            for (const l of lines) {
              line += "\n" + theme.fg("dim", `   ${l}`);
            }
            if (resultText.split("\n").length > 50) {
              line += "\n" + theme.fg("muted", "   ... (use get_agent_result with verbose for full output)");
            }
          }
        } else {
          const doneText = isSteered ? "Wrapped up (turn limit)" : "Done";
          line += "\n" + theme.fg("dim", `   ⎿  ${doneText}`);
        }
        return new Text(line, 0, 0);
      }

      // ---- Stopped (user-initiated abort) ----
      if (details.status === "stopped") {
        let line = theme.fg("dim", "■") + " " + theme.fg("toolTitle", details.description);
        line += " " + theme.fg("dim", "·") + " " + theme.fg("dim", `${details.toolUses} tool use${details.toolUses === 1 ? "" : "s"}`);
        if (details.tokens) {
          line += " " + theme.fg("dim", "·") + " " + theme.fg("dim", details.tokens);
        }
        line += "\n" + theme.fg("dim", "   ⎿  Stopped");
        return new Text(line, 0, 0);
      }

      // ---- Error / Aborted (hard max_turns) ----
      let line = theme.fg("error", "✗") + " " + theme.fg("toolTitle", details.description);
      line += " " + theme.fg("dim", "·") + " " + theme.fg("dim", `${details.toolUses} tool use${details.toolUses === 1 ? "" : "s"}`);
      if (details.tokens) {
        line += " " + theme.fg("dim", "·") + " " + theme.fg("dim", details.tokens);
      }

      if (details.status === "error") {
        line += "\n" + theme.fg("error", `   ⎿  Error: ${details.error ?? "unknown"}`);
      } else {
        line += "\n" + theme.fg("warning", "   ⎿  Aborted (max turns exceeded)");
      }

      return new Text(line, 0, 0);
    },

    // ---- Execute ----

    execute: async (_toolCallId, params, signal, onUpdate, ctx) => {
      const subagentType = params.subagent_type as SubagentType;

      // Validate subagent type
      if (!isValidType(subagentType)) {
        return textResult(`Unknown agent type: "${params.subagent_type}". Valid types: ${allTypes.join(", ")}`);
      }

      const displayName = getDisplayName(subagentType);

      // Get custom agent config (if any)
      const customConfig = getCustomAgentConfig(subagentType);

      // Resolve model if specified (supports exact "provider/modelId" or fuzzy match)
      let model = ctx.model;
      if (params.model) {
        const resolved = resolveModel(params.model, ctx.modelRegistry);
        if (typeof resolved === "string") {
          return textResult(resolved);
        }
        model = resolved;
      }

      // Resolve thinking: explicit param > custom config > undefined
      const thinking = (params.thinking ?? customConfig?.thinking) as ThinkingLevel | undefined;

      // Resolve spawn-time defaults from custom config (caller overrides)
      const inheritContext = params.inherit_context ?? customConfig?.inheritContext ?? false;
      const runInBackground = params.run_in_background ?? customConfig?.runInBackground ?? false;
      const isolated = params.isolated ?? customConfig?.isolated ?? false;

      const { systemPromptOverride, systemPromptAppend } = resolveCustomPrompt(customConfig);

      // Resume existing agent
      if (params.resume) {
        const existing = manager.getRecord(params.resume);
        if (!existing) {
          return textResult(`Agent not found: "${params.resume}". It may have been cleaned up.`);
        }
        if (!existing.session) {
          return textResult(`Agent "${params.resume}" has no active session to resume.`);
        }
        const record = await manager.resume(params.resume, params.prompt, signal);
        if (!record) {
          return textResult(`Failed to resume agent "${params.resume}".`);
        }
        const durationMs = (record.completedAt ?? Date.now()) - record.startedAt;
        let resumeTokens = "";
        if (record.session) {
          try { resumeTokens = formatTokens(record.session.getSessionStats().tokens.total); } catch { /* ignore */ }
        }
        return textResult(
          record.result ?? record.error ?? "No output.",
          {
            displayName,
            description: params.description,
            subagentType,
            toolUses: record.toolUses,
            tokens: resumeTokens,
            durationMs,
            status: record.status,
            agentId: record.id,
          },
        );
      }

      // Background execution
      if (runInBackground) {
        const id = manager.spawn(pi, ctx, subagentType, params.prompt, {
          description: params.description,
          model,
          maxTurns: params.max_turns,
          isolated,
          inheritContext,
          thinkingLevel: thinking,
          systemPromptOverride,
          systemPromptAppend,
          isBackground: true,
        });
        updateAgentStatus();
        return textResult(
          `Agent started in background.\n` +
          `Agent ID: ${id}\n` +
          `Type: ${displayName}\n` +
          `Description: ${params.description}\n\n` +
          `You will be notified when this agent completes.\n` +
          `Use get_agent_result to retrieve full results, or steer_agent to send it messages.\n` +
          `Do not duplicate this agent's work.`,
          {
            displayName,
            description: params.description,
            subagentType,
            toolUses: 0,
            tokens: "",
            durationMs: 0,
            status: "background",
            agentId: id,
          },
        );
      }

      // Foreground (synchronous) execution — stream progress via onUpdate
      let toolUses = 0;
      let tokenText = "";
      let spinnerFrame = 0;
      let agentSession: { getSessionStats(): { tokens: { total: number } } } | undefined;
      const startedAt = Date.now();
      const activeTools = new Map<string, string>(); // key → toolName

      const streamUpdate = () => {
        const details: AgentDetails = {
          displayName,
          description: params.description,
          subagentType,
          toolUses,
          tokens: tokenText,
          durationMs: Date.now() - startedAt,
          status: "running",
          activity: describeActivity(activeTools),
          spinnerFrame: spinnerFrame % SPINNER.length,
        };
        onUpdate?.({
          content: [{ type: "text", text: `${toolUses} tool uses...` }],
          details: details as any,
        });
      };

      // Animate spinner at ~80ms (smooth rotation through 10 braille frames)
      const spinnerInterval = setInterval(() => {
        spinnerFrame++;
        streamUpdate();
      }, 80);

      streamUpdate();

      const record = await manager.spawnAndWait(pi, ctx, subagentType, params.prompt, {
        description: params.description,
        model,
        maxTurns: params.max_turns,
        isolated,
        inheritContext,
        thinkingLevel: thinking,
        systemPromptOverride,
        systemPromptAppend,
        onSessionCreated: (session) => {
          agentSession = session;
        },
        onToolActivity: (activity) => {
          if (activity.type === "start") {
            activeTools.set(activity.toolName + "_" + Date.now(), activity.toolName);
          } else {
            // Remove one instance of this tool
            for (const [key, name] of activeTools) {
              if (name === activity.toolName) {
                activeTools.delete(key);
                break;
              }
            }
            toolUses++;
          }
          // Update token count from session (stored on record by onSessionCreated)
          if (agentSession) {
            try {
              const stats = agentSession.getSessionStats();
              tokenText = formatTokens(stats.tokens.total);
            } catch { /* session may not be ready */ }
          }
          streamUpdate();
        },
      });

      clearInterval(spinnerInterval);

      // Get final token count
      if (agentSession) {
        try {
          tokenText = formatTokens(agentSession.getSessionStats().tokens.total);
        } catch { /* ignore */ }
      }

      if (record.status === "error") {
        return textResult(
          `Agent failed: ${record.error}`,
          {
            displayName,
            description: params.description,
            subagentType,
            toolUses: record.toolUses,
            tokens: tokenText,
            durationMs: (record.completedAt ?? Date.now()) - record.startedAt,
            status: "error",
            error: record.error,
          },
        );
      }

      const durationMs = (record.completedAt ?? Date.now()) - record.startedAt;
      const statusNote = record.status === "aborted"
        ? " (aborted — max turns exceeded, output may be incomplete)"
        : record.status === "steered"
          ? " (wrapped up — reached turn limit)"
          : record.status === "stopped"
            ? " (stopped by user)"
            : "";

      return textResult(
        `Agent completed in ${formatMs(durationMs)} (${record.toolUses} tool uses)${statusNote}.\n\n` +
        (record.result ?? "No output."),
        {
          displayName,
          description: params.description,
          subagentType,
          toolUses: record.toolUses,
          tokens: tokenText,
          durationMs,
          status: record.status,
          agentId: record.id,
        },
      );
    },
  });

  // ---- get_agent_result tool ----

  pi.registerTool({
    name: "get_agent_result",
    label: "Get Agent Result",
    description:
      "Check status and retrieve results from a background agent. Use the agent ID returned by spawn_agent with run_in_background.",
    parameters: Type.Object({
      agent_id: Type.String({
        description: "The agent ID to check.",
      }),
      wait: Type.Optional(
        Type.Boolean({
          description: "If true, wait for the agent to complete before returning. Default: false.",
        }),
      ),
      verbose: Type.Optional(
        Type.Boolean({
          description: "If true, include the agent's full conversation (messages + tool calls). Default: false.",
        }),
      ),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      const record = manager.getRecord(params.agent_id);
      if (!record) {
        return textResult(`Agent not found: "${params.agent_id}". It may have been cleaned up.`);
      }

      // Wait for completion if requested
      if (params.wait && record.status === "running" && record.promise) {
        await record.promise;
      }

      const displayName = getDisplayName(record.type);
      const duration = formatDuration(record.startedAt, record.completedAt);

      let output =
        `Agent: ${record.id}\n` +
        `Type: ${displayName} | Status: ${record.status} | Tool uses: ${record.toolUses} | Duration: ${duration}\n` +
        `Description: ${record.description}\n\n`;

      if (record.status === "running") {
        output += "Agent is still running. Use wait: true or check back later.";
      } else if (record.status === "error") {
        output += `Error: ${record.error}`;
      } else {
        output += record.result ?? "No output.";
      }

      // Verbose: include full conversation
      if (params.verbose && record.session) {
        const conversation = getAgentConversation(record.session);
        if (conversation) {
          output += `\n\n--- Agent Conversation ---\n${conversation}`;
        }
      }

      return textResult(output);
    },
  });

  // ---- steer_agent tool ----

  pi.registerTool({
    name: "steer_agent",
    label: "Steer Agent",
    description:
      "Send a steering message to a running agent. The message will interrupt the agent after its current tool execution " +
      "and be injected into its conversation, allowing you to redirect its work mid-run. Only works on running agents.",
    parameters: Type.Object({
      agent_id: Type.String({
        description: "The agent ID to steer (must be currently running).",
      }),
      message: Type.String({
        description: "The steering message to send. This will appear as a user message in the agent's conversation.",
      }),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      const record = manager.getRecord(params.agent_id);
      if (!record) {
        return textResult(`Agent not found: "${params.agent_id}". It may have been cleaned up.`);
      }
      if (record.status !== "running") {
        return textResult(`Agent "${params.agent_id}" is not running (status: ${record.status}). Cannot steer a non-running agent.`);
      }
      if (!record.session) {
        return textResult(`Agent "${params.agent_id}" has no active session yet. It may still be initializing.`);
      }

      try {
        await steerAgent(record.session, params.message);
        return textResult(`Steering message sent to agent ${record.id}. The agent will process it after its current tool execution.`);
      } catch (err) {
        return textResult(`Failed to steer agent: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  });

  // ---- /agent command ----

  pi.registerCommand("agent", {
    description: "Spawn a sub-agent: /agent <type> <prompt>",
    handler: async (args, ctx) => {
      const trimmed = args?.trim() ?? "";

      if (!trimmed) {
        const lines = [
          "Usage: /agent <type> <prompt>",
          "",
          "Agent types:",
          ...allTypes.map(
            (t) => `  ${t.padEnd(20)} ${getConfig(t).description}`,
          ),
          "",
          "Examples:",
          "  /agent Explore Find all TypeScript files that handle authentication",
          "  /agent Plan Design a caching layer for the API",
          "  /agent general-purpose Refactor the auth module to use JWT",
        ];
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      // Parse: first word is type, rest is prompt
      const spaceIdx = trimmed.indexOf(" ");
      if (spaceIdx === -1) {
        ctx.ui.notify(
          `Missing prompt. Usage: /agent <type> <prompt>\nTypes: ${allTypes.join(", ")}`,
          "warning",
        );
        return;
      }

      const typeName = trimmed.slice(0, spaceIdx);
      const prompt = trimmed.slice(spaceIdx + 1).trim();

      if (!isValidType(typeName)) {
        ctx.ui.notify(
          `Unknown agent type: "${typeName}"\nValid types: ${allTypes.join(", ")}`,
          "warning",
        );
        return;
      }

      if (!prompt) {
        ctx.ui.notify("Missing prompt.", "warning");
        return;
      }

      const displayName = getDisplayName(typeName);
      ctx.ui.notify(`Spawning ${displayName} agent...`, "info");

      const customConfig = getCustomAgentConfig(typeName);
      const { systemPromptOverride, systemPromptAppend } = resolveCustomPrompt(customConfig);

      const record = await manager.spawnAndWait(pi, ctx, typeName, prompt, {
        description: prompt.slice(0, 40),
        thinkingLevel: customConfig?.thinking,
        systemPromptOverride,
        systemPromptAppend,
      });

      if (record.status === "error") {
        ctx.ui.notify(`Agent failed: ${record.error}`, "warning");
        return;
      }

      const duration = formatDuration(record.startedAt, record.completedAt);
      const statusNote = record.status === "aborted" ? " (aborted — max turns exceeded)"
        : record.status === "steered" ? " (wrapped up — turn limit)"
        : record.status === "stopped" ? " (stopped)"
        : "";

      // Send the result as a message so it appears in the conversation
      pi.sendMessage(
        {
          customType: "agent-result",
          content: [
            {
              type: "text",
              text:
                `**${displayName}** agent completed in ${duration} (${record.toolUses} tool uses)${statusNote}\n\n` +
                (record.result ?? "No output."),
            },
          ],
          display: true,
        },
        { triggerTurn: false },
      );
    },
  });

  // ---- /agents command ----

  pi.registerCommand("agents", {
    description: "List all agents with status",
    handler: async (_args, ctx) => {
      const agents = manager.listAgents();

      if (agents.length === 0) {
        ctx.ui.notify("No agents have been spawned yet.", "info");
        return;
      }

      const lines: string[] = [];
      const counts: Record<string, number> = {};
      for (const a of agents) counts[a.status] = (counts[a.status] ?? 0) + 1;

      lines.push(
        `${agents.length} agent(s): ${counts.running ?? 0} running, ${(counts.completed ?? 0) + (counts.steered ?? 0)} completed, ${counts.stopped ?? 0} stopped, ${counts.aborted ?? 0} aborted, ${counts.error ?? 0} errored`,
      );
      lines.push("");

      for (let i = 0; i < agents.length; i++) {
        const a = agents[i];
        const connector = i === agents.length - 1 ? "└─" : "├─";
        const displayName = getDisplayName(a.type);
        const duration = formatDuration(a.startedAt, a.completedAt);

        lines.push(
          `${connector} ${displayName} (${a.description}) · ${a.toolUses} tool uses · ${a.status} · ${duration}`,
        );

        if (a.status === "error" && a.error) {
          const indent = i === agents.length - 1 ? "   " : "│  ";
          lines.push(`${indent} ⎿  Error: ${a.error.slice(0, 100)}`);
        }
        if (a.session) {
          const indent = i === agents.length - 1 ? "   " : "│  ";
          lines.push(`${indent} ⎿  ID: ${a.id} (resumable)`);
        }
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
