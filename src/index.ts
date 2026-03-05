/**
 * pi-agents — A pi extension providing Claude Code-style autonomous sub-agents.
 *
 * Tools:
 *   Agent             — LLM-callable: spawn a sub-agent
 *   get_subagent_result  — LLM-callable: check background agent status/result
 *   steer_subagent       — LLM-callable: send a steering message to a running agent
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
import { SUBAGENT_TYPES, type SubagentType, type ThinkingLevel, type CustomAgentConfig } from "./types.js";
import { getConfig, getAvailableTypes, getCustomAgentNames, getCustomAgentConfig, isValidType, registerCustomAgents } from "./agent-types.js";
import { loadCustomAgents } from "./custom-agents.js";
import {
  AgentWidget,
  SPINNER,
  formatTokens,
  formatMs,
  formatDuration,
  getDisplayName,
  describeActivity,
  type AgentDetails,
  type AgentActivity,
  type UICtx,
} from "./ui/agent-widget.js";

// ---- Shared helpers ----

/** Tool execute return value for a text response. */
function textResult(msg: string, details?: AgentDetails) {
  return { content: [{ type: "text" as const, text: msg }], details: details as any };
}

/** Safe token formatting — wraps session.getSessionStats() in try-catch. */
function safeFormatTokens(session: { getSessionStats(): { tokens: { total: number } } } | undefined): string {
  if (!session) return "";
  try { return formatTokens(session.getSessionStats().tokens.total); } catch { return ""; }
}

/**
 * Create an AgentActivity state and spawn callbacks for tracking tool usage.
 * Used by both foreground and background paths to avoid duplication.
 */
function createActivityTracker(onStreamUpdate?: () => void) {
  const state: AgentActivity = { activeTools: new Map(), toolUses: 0, tokens: "", responseText: "", session: undefined };

  const callbacks = {
    onToolActivity: (activity: { type: "start" | "end"; toolName: string }) => {
      if (activity.type === "start") {
        state.activeTools.set(activity.toolName + "_" + Date.now(), activity.toolName);
      } else {
        for (const [key, name] of state.activeTools) {
          if (name === activity.toolName) { state.activeTools.delete(key); break; }
        }
        state.toolUses++;
      }
      state.tokens = safeFormatTokens(state.session);
      onStreamUpdate?.();
    },
    onTextDelta: (_delta: string, fullText: string) => {
      state.responseText = fullText;
      onStreamUpdate?.();
    },
    onSessionCreated: (session: any) => {
      state.session = session;
    },
  };

  return { state, callbacks };
}

/** Human-readable status label for agent completion. */
function getStatusLabel(status: string, error?: string): string {
  switch (status) {
    case "error": return `Error: ${error ?? "unknown"}`;
    case "aborted": return "Aborted (max turns exceeded)";
    case "steered": return "Wrapped up (turn limit)";
    case "stopped": return "Stopped";
    default: return "Done";
  }
}

/** Parenthetical status note for completed agent result text. */
function getStatusNote(status: string): string {
  switch (status) {
    case "aborted": return " (aborted — max turns exceeded, output may be incomplete)";
    case "steered": return " (wrapped up — reached turn limit)";
    case "stopped": return " (stopped by user)";
    default: return "";
  }
}

/** Build AgentDetails from a base + record-specific fields. */
function buildDetails(
  base: Pick<AgentDetails, "displayName" | "description" | "subagentType" | "modelName" | "tags">,
  record: { toolUses: number; startedAt: number; completedAt?: number; status: string; error?: string; id?: string; session?: any },
  overrides?: Partial<AgentDetails>,
): AgentDetails {
  return {
    ...base,
    toolUses: record.toolUses,
    tokens: safeFormatTokens(record.session),
    durationMs: (record.completedAt ?? Date.now()) - record.startedAt,
    status: record.status as AgentDetails["status"],
    agentId: record.id,
    error: record.error,
    ...overrides,
  };
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
  registry: { find(provider: string, modelId: string): any; getAll(): any[]; getAvailable?(): any[] },
): any | string {
  // 1. Exact match: "provider/modelId"
  const slashIdx = input.indexOf("/");
  if (slashIdx !== -1) {
    const provider = input.slice(0, slashIdx);
    const modelId = input.slice(slashIdx + 1);
    const found = registry.find(provider, modelId);
    if (found) return found;
  }

  // 2. Fuzzy match against available models (those with auth configured)
  const all = (registry.getAvailable?.() ?? registry.getAll()) as { id: string; name: string; provider: string }[];
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
  const modelList = all
    .map(m => `  ${m.provider}/${m.id}`)
    .sort()
    .join("\n");
  return `Model not found: "${input}".\n\nAvailable models:\n${modelList}`;
}

export default function (pi: ExtensionAPI) {
  /** Reload custom agents from .pi/agents/*.md (called on init and each Agent invocation). */
  const reloadCustomAgents = () => {
    const agents = loadCustomAgents(process.cwd());
    registerCustomAgents(agents);
  };

  // Initial load
  reloadCustomAgents();

  // ---- Agent activity tracking + widget ----
  const agentActivity = new Map<string, AgentActivity>();

  // Background completion: push notification into conversation
  const manager = new AgentManager((record) => {
    const displayName = getDisplayName(record.type);
    const duration = formatDuration(record.startedAt, record.completedAt);

    const status = getStatusLabel(record.status, record.error);

    const resultPreview = record.result
      ? record.result.length > 500
        ? record.result.slice(0, 500) + "\n...(truncated, use get_subagent_result for full output)"
        : record.result
      : "No output.";

    agentActivity.delete(record.id);
    widget.markFinished(record.id);

    // Poke the main agent so it processes the result (queues as follow-up if busy)
    pi.sendUserMessage(
      `Background agent completed: ${displayName} (${record.description})\n` +
      `Agent ID: ${record.id} | Status: ${status} | Tool uses: ${record.toolUses} | Duration: ${duration}\n\n` +
      resultPreview,
      { deliverAs: "followUp" },
    );
    widget.update();
  });

  // Live widget: show running agents above editor
  const widget = new AgentWidget(manager, agentActivity);

  // Grab UI context from first tool execution + clear lingering widget on new turn
  pi.on("tool_execution_start", async (_event, ctx) => {
    widget.setUICtx(ctx.ui as UICtx);
    widget.onTurnStart();
  });

  // Build type description text (static built-in + dynamic custom note)
  const builtinDescs = [
    "- general-purpose: Full tool access for complex multi-step tasks.",
    "- Explore: Fast codebase exploration (read-only, defaults to haiku).",
    "- Plan: Software architect for implementation planning (read-only).",
    "- statusline-setup: Configuration editor (read + edit only).",
    "- claude-code-guide: Documentation and help queries (read-only).",
  ];

  /** Build the full type list text, including any currently loaded custom agents. */
  const buildTypeListText = () => {
    const names = getCustomAgentNames();
    const customDescs = names.map((name) => {
      const cfg = getCustomAgentConfig(name);
      return `- ${name}: ${cfg?.description ?? name}`;
    });
    return [
      "Built-in types:",
      ...builtinDescs,
      ...(customDescs.length > 0 ? ["", "Custom types:", ...customDescs] : []),
      "",
      "Custom agents can be defined in .pi/agents/<name>.md — they are picked up automatically.",
    ].join("\n");
  };

  const typeListText = buildTypeListText();

  // ---- Agent tool ----

  pi.registerTool<any, AgentDetails>({
    name: "Agent",
    label: "Agent",
    description: `Launch a new agent to handle complex, multi-step tasks autonomously.

The Agent tool launches specialized agents that autonomously handle complex tasks. Each agent type has specific capabilities and tools available to it.

Available agent types:
${typeListText}

Guidelines:
- For parallel work, use run_in_background: true on each agent. Foreground calls run sequentially — only one executes at a time.
- Use Explore for codebase searches and code understanding.
- Use Plan for architecture and implementation planning.
- Use general-purpose for complex tasks that need file editing.
- Provide clear, detailed prompts so the agent can work autonomously.
- Agent results are returned as text — summarize them for the user.
- Use run_in_background for work you don't need immediately. You will be notified when it completes.
- Use resume with an agent ID to continue a previous agent's work.
- Use steer_subagent to send mid-run messages to a running background agent.
- Use model to specify a different model (as "provider/modelId", or fuzzy e.g. "haiku", "sonnet").
- Use thinking to control extended thinking level.
- Use inherit_context if the agent needs the parent conversation history.`,
    parameters: Type.Object({
      prompt: Type.String({
        description: "The task for the agent to perform.",
      }),
      description: Type.String({
        description: "A short (3-5 word) description of the task (shown in UI).",
      }),
      subagent_type: Type.String({
        description: `The type of specialized agent to use. Built-in: ${SUBAGENT_TYPES.join(", ")}. Custom agents from .pi/agents/*.md are also available.`,
      }),
      model: Type.Optional(
        Type.String({
          description:
            'Optional model to use. Accepts "provider/modelId" or fuzzy name (e.g. "haiku", "sonnet"). If omitted, Explore defaults to haiku; others inherit from parent.',
        }),
      ),
      thinking: Type.Optional(
        Type.String({
          description: "Thinking level: off, minimal, low, medium, high, xhigh. Overrides agent default.",
        }),
      ),
      max_turns: Type.Optional(
        Type.Number({
          description: "Maximum number of agentic turns before stopping.",
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
          description: "Optional agent ID to resume from. Continues from previous context.",
        }),
      ),
      isolated: Type.Optional(
        Type.Boolean({
          description: "If true, agent gets no extension/MCP tools — only built-in tools.",
        }),
      ),
      inherit_context: Type.Optional(
        Type.Boolean({
          description: "If true, fork parent conversation into the agent. Default: false (fresh context).",
        }),
      ),
    }),

    // ---- Custom rendering: Claude Code style ----

    renderCall(args, theme) {
      const displayName = args.subagent_type ? getDisplayName(args.subagent_type) : "Agent";
      const desc = args.description ?? "";
      return new Text("▸ " + theme.fg("toolTitle", theme.bold(displayName)) + (desc ? "  " + theme.fg("muted", desc) : ""), 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      const details = result.details as AgentDetails | undefined;
      if (!details) {
        const text = result.content[0]?.type === "text" ? result.content[0].text : "";
        return new Text(text, 0, 0);
      }

      // Helper: build "haiku · thinking: high · 3 tool uses · 33.8k tokens" stats string
      const stats = (d: AgentDetails) => {
        const parts: string[] = [];
        if (d.modelName) parts.push(d.modelName);
        if (d.tags) parts.push(...d.tags);
        if (d.toolUses > 0) parts.push(`${d.toolUses} tool use${d.toolUses === 1 ? "" : "s"}`);
        if (d.tokens) parts.push(d.tokens);
        return parts.map(p => theme.fg("dim", p)).join(" " + theme.fg("dim", "·") + " ");
      };

      // ---- While running (streaming) ----
      if (isPartial || details.status === "running") {
        const frame = SPINNER[details.spinnerFrame ?? 0];
        const s = stats(details);
        let line = theme.fg("accent", frame) + (s ? " " + s : "");
        line += "\n" + theme.fg("dim", `  ⎿  ${details.activity ?? "thinking…"}`);
        return new Text(line, 0, 0);
      }

      // ---- Background agent launched ----
      if (details.status === "background") {
        return new Text(theme.fg("dim", `  ⎿  Running in background (ID: ${details.agentId})`), 0, 0);
      }

      // ---- Completed / Steered ----
      if (details.status === "completed" || details.status === "steered") {
        const duration = formatMs(details.durationMs);
        const isSteered = details.status === "steered";
        const icon = isSteered ? theme.fg("warning", "✓") : theme.fg("success", "✓");
        const s = stats(details);
        let line = icon + (s ? " " + s : "");
        line += " " + theme.fg("dim", "·") + " " + theme.fg("dim", duration);

        if (expanded) {
          const resultText = result.content[0]?.type === "text" ? result.content[0].text : "";
          if (resultText) {
            const lines = resultText.split("\n").slice(0, 50);
            for (const l of lines) {
              line += "\n" + theme.fg("dim", `  ${l}`);
            }
            if (resultText.split("\n").length > 50) {
              line += "\n" + theme.fg("muted", "  ... (use get_subagent_result with verbose for full output)");
            }
          }
        } else {
          const doneText = isSteered ? "Wrapped up (turn limit)" : "Done";
          line += "\n" + theme.fg("dim", `  ⎿  ${doneText}`);
        }
        return new Text(line, 0, 0);
      }

      // ---- Stopped (user-initiated abort) ----
      if (details.status === "stopped") {
        const s = stats(details);
        let line = theme.fg("dim", "■") + (s ? " " + s : "");
        line += "\n" + theme.fg("dim", "  ⎿  Stopped");
        return new Text(line, 0, 0);
      }

      // ---- Error / Aborted (hard max_turns) ----
      const s = stats(details);
      let line = theme.fg("error", "✗") + (s ? " " + s : "");

      if (details.status === "error") {
        line += "\n" + theme.fg("error", `  ⎿  Error: ${details.error ?? "unknown"}`);
      } else {
        line += "\n" + theme.fg("warning", "  ⎿  Aborted (max turns exceeded)");
      }

      return new Text(line, 0, 0);
    },

    // ---- Execute ----

    execute: async (_toolCallId, params, signal, onUpdate, ctx) => {
      // Ensure we have UI context for widget rendering
      widget.setUICtx(ctx.ui as UICtx);

      // Reload custom agents so new .pi/agents/*.md files are picked up without restart
      reloadCustomAgents();

      const subagentType = params.subagent_type as SubagentType;

      // Validate subagent type
      if (!isValidType(subagentType)) {
        return textResult(`Unknown agent type: "${params.subagent_type}". Valid types: ${getAvailableTypes().join(", ")}`);
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

      // Build display tags for non-default config
      const parentModelId = ctx.model?.id;
      const effectiveModelId = model?.id;
      const agentModelName = effectiveModelId && effectiveModelId !== parentModelId
        ? (model?.name ?? effectiveModelId).replace(/^Claude\s+/i, "").toLowerCase()
        : undefined;
      const agentTags: string[] = [];
      if (thinking) agentTags.push(`thinking: ${thinking}`);
      if (isolated) agentTags.push("isolated");
      // Shared base fields for all AgentDetails in this call
      const detailBase = {
        displayName,
        description: params.description,
        subagentType,
        modelName: agentModelName,
        tags: agentTags.length > 0 ? agentTags : undefined,
      };

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
        return textResult(
          record.result ?? record.error ?? "No output.",
          buildDetails(detailBase, record),
        );
      }

      // Background execution
      if (runInBackground) {
        const { state: bgState, callbacks: bgCallbacks } = createActivityTracker();

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
          ...bgCallbacks,
        });

        agentActivity.set(id, bgState);
        widget.ensureTimer();
        widget.update();
        const record = manager.getRecord(id);
        const isQueued = record?.status === "queued";
        return textResult(
          `Agent ${isQueued ? "queued" : "started"} in background.\n` +
          `Agent ID: ${id}\n` +
          `Type: ${displayName}\n` +
          `Description: ${params.description}\n` +
          (isQueued ? `Position: queued (max ${manager.getMaxConcurrent()} concurrent)\n` : "") +
          `\nYou will be notified when this agent completes.\n` +
          `Use get_subagent_result to retrieve full results, or steer_subagent to send it messages.\n` +
          `Do not duplicate this agent's work.`,
          { ...detailBase, toolUses: 0, tokens: "", durationMs: 0, status: "background" as const, agentId: id },
        );
      }

      // Foreground (synchronous) execution — stream progress via onUpdate
      let spinnerFrame = 0;
      const startedAt = Date.now();
      let fgId: string | undefined;

      const streamUpdate = () => {
        const details: AgentDetails = {
          ...detailBase,
          toolUses: fgState.toolUses,
          tokens: fgState.tokens,
          durationMs: Date.now() - startedAt,
          status: "running",
          activity: describeActivity(fgState.activeTools, fgState.responseText),
          spinnerFrame: spinnerFrame % SPINNER.length,
        };
        onUpdate?.({
          content: [{ type: "text", text: `${fgState.toolUses} tool uses...` }],
          details: details as any,
        });
      };

      const { state: fgState, callbacks: fgCallbacks } = createActivityTracker(streamUpdate);

      // Wire session creation to register in widget
      const origOnSession = fgCallbacks.onSessionCreated;
      fgCallbacks.onSessionCreated = (session: any) => {
        origOnSession(session);
        for (const a of manager.listAgents()) {
          if (a.session === session) {
            fgId = a.id;
            agentActivity.set(a.id, fgState);
            widget.ensureTimer();
            break;
          }
        }
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
        ...fgCallbacks,
      });

      clearInterval(spinnerInterval);

      // Clean up foreground agent from widget
      if (fgId) {
        agentActivity.delete(fgId);
        widget.markFinished(fgId);
      }

      // Get final token count
      const tokenText = safeFormatTokens(fgState.session);

      const details = buildDetails(detailBase, record, { tokens: tokenText });

      if (record.status === "error") {
        return textResult(`Agent failed: ${record.error}`, details);
      }

      const durationMs = (record.completedAt ?? Date.now()) - record.startedAt;
      return textResult(
        `Agent completed in ${formatMs(durationMs)} (${record.toolUses} tool uses)${getStatusNote(record.status)}.\n\n` +
        (record.result ?? "No output."),
        details,
      );
    },
  });

  // ---- get_subagent_result tool ----

  pi.registerTool({
    name: "get_subagent_result",
    label: "Get Agent Result",
    description:
      "Check status and retrieve results from a background agent. Use the agent ID returned by Agent with run_in_background.",
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

  // ---- steer_subagent tool ----

  pi.registerTool({
    name: "steer_subagent",
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
          ...getAvailableTypes().map(
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
          `Missing prompt. Usage: /agent <type> <prompt>\nTypes: ${getAvailableTypes().join(", ")}`,
          "warning",
        );
        return;
      }

      const typeName = trimmed.slice(0, spaceIdx);
      const prompt = trimmed.slice(spaceIdx + 1).trim();

      if (!isValidType(typeName)) {
        ctx.ui.notify(
          `Unknown agent type: "${typeName}"\nValid types: ${getAvailableTypes().join(", ")}`,
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
      const statusNote = getStatusNote(record.status);

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
