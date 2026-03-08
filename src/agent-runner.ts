/**
 * agent-runner.ts — Core execution engine: creates sessions, runs agents, collects results.
 */

import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type ExtensionAPI,
} from "@mariozechner/pi-coding-agent";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Model } from "@mariozechner/pi-ai";
import { getToolsForType, getConfig, getAgentConfig } from "./agent-types.js";
import { buildAgentPrompt } from "./prompts.js";
import { buildParentContext, extractText } from "./context.js";
import { detectEnv } from "./env.js";
import type { SubagentType, ThinkingLevel } from "./types.js";

/** Names of tools registered by this extension that subagents must NOT inherit. */
const EXCLUDED_TOOL_NAMES = ["Agent", "get_subagent_result", "steer_subagent"];

/** Default max turns to prevent subagents from looping indefinitely. */
let defaultMaxTurns = 50;

/** Get the default max turns value. */
export function getDefaultMaxTurns(): number { return defaultMaxTurns; }
/** Set the default max turns value (minimum 1). */
export function setDefaultMaxTurns(n: number): void { defaultMaxTurns = Math.max(1, n); }

/** Additional turns allowed after the soft limit steer message. */
let graceTurns = 5;

/** Get the grace turns value. */
export function getGraceTurns(): number { return graceTurns; }
/** Set the grace turns value (minimum 1). */
export function setGraceTurns(n: number): void { graceTurns = Math.max(1, n); }

/**
 * Try to find the right model for an agent type.
 * Priority: explicit option > config.model > parent model.
 */
function resolveDefaultModel(
  parentModel: Model<any> | undefined,
  registry: { find(provider: string, modelId: string): Model<any> | undefined; getAvailable?(): Model<any>[] },
  configModel?: string,
): Model<any> | undefined {
  if (configModel) {
    const slashIdx = configModel.indexOf("/");
    if (slashIdx !== -1) {
      const provider = configModel.slice(0, slashIdx);
      const modelId = configModel.slice(slashIdx + 1);

      // Build a set of available model keys for fast lookup
      const available = registry.getAvailable?.();
      const availableKeys = available
        ? new Set(available.map((m: any) => `${m.provider}/${m.id}`))
        : undefined;
      const isAvailable = (p: string, id: string) =>
        !availableKeys || availableKeys.has(`${p}/${id}`);

      const found = registry.find(provider, modelId);
      if (found && isAvailable(provider, modelId)) return found;
    }
  }

  return parentModel;
}

/** Info about a tool event in the subagent. */
export interface ToolActivity {
  type: "start" | "end";
  toolName: string;
}

export interface RunOptions {
  /** ExtensionAPI instance — used for pi.exec() instead of execSync. */
  pi: ExtensionAPI;
  model?: Model<any>;
  maxTurns?: number;
  signal?: AbortSignal;
  isolated?: boolean;
  inheritContext?: boolean;
  thinkingLevel?: ThinkingLevel;
  /** Override system prompt entirely (for custom agents with promptMode: "replace"). */
  systemPromptOverride?: string;
  /** Append to default system prompt (for custom agents with promptMode: "append"). */
  systemPromptAppend?: string;
  /** Called on tool start/end with activity info. */
  onToolActivity?: (activity: ToolActivity) => void;
  /** Called on streaming text deltas from the assistant response. */
  onTextDelta?: (delta: string, fullText: string) => void;
  onSessionCreated?: (session: AgentSession) => void;
}

export interface RunResult {
  responseText: string;
  session: AgentSession;
  /** True if the agent was hard-aborted (max_turns + grace exceeded). */
  aborted: boolean;
  /** True if the agent was steered to wrap up (hit soft turn limit) but finished in time. */
  steered: boolean;
}

/**
 * Subscribe to a session and collect the last assistant message text.
 * Returns an object with a `getText()` getter and an `unsubscribe` function.
 */
function collectResponseText(session: AgentSession) {
  let text = "";
  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "message_start") {
      text = "";
    }
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      text += event.assistantMessageEvent.delta;
    }
  });
  return { getText: () => text, unsubscribe };
}

/**
 * Wire an AbortSignal to abort a session.
 * Returns a cleanup function to remove the listener.
 */
function forwardAbortSignal(session: AgentSession, signal?: AbortSignal): () => void {
  if (!signal) return () => {};
  const onAbort = () => session.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

export async function runAgent(
  ctx: ExtensionContext,
  type: SubagentType,
  prompt: string,
  options: RunOptions,
): Promise<RunResult> {
  const config = getConfig(type);
  const agentConfig = getAgentConfig(type);
  const env = await detectEnv(options.pi, ctx.cwd);

  // Build system prompt: custom override > custom append > config-driven
  let systemPrompt: string;
  if (options.systemPromptOverride) {
    systemPrompt = options.systemPromptOverride;
  } else if (options.systemPromptAppend) {
    // Build a default prompt and append to it
    const defaultConfig = agentConfig ?? {
      name: type,
      description: "",
      builtinToolNames: [],
      extensions: true,
      skills: true,
      systemPrompt: "",
      promptMode: "replace" as const,
      inheritContext: false,
      runInBackground: false,
      isolated: false,
    };
    systemPrompt = buildAgentPrompt(defaultConfig, ctx.cwd, env) + "\n\n" + options.systemPromptAppend;
  } else if (agentConfig) {
    systemPrompt = buildAgentPrompt(agentConfig, ctx.cwd, env);
  } else {
    // Unknown type — use a minimal general-purpose prompt
    systemPrompt = buildAgentPrompt({
      name: type,
      description: "General-purpose agent",
      builtinToolNames: [],
      extensions: true,
      skills: true,
      systemPrompt: `# Role
You are a general-purpose coding agent for complex, multi-step tasks.
You have full access to read, write, edit files, and execute commands.
Do what has been asked; nothing more, nothing less.

# Tool Usage
- Use the read tool instead of cat/head/tail
- Use the edit tool instead of sed/awk
- Use the write tool instead of echo/heredoc
- Use the find tool instead of bash find/ls for file search
- Use the grep tool instead of bash grep/rg for content search
- Make independent tool calls in parallel

# Output
- Use absolute file paths
- Do not use emojis
- Be concise but complete`,
      promptMode: "replace",
      inheritContext: false,
      runInBackground: false,
      isolated: false,
    }, ctx.cwd, env);
  }

  const tools = getToolsForType(type, ctx.cwd);

  // Resolve extensions/skills: isolated overrides to false
  const extensions = options.isolated ? false : config.extensions;
  const skills = options.isolated ? false : config.skills;

  // Load extensions/skills: true or string[] → load; false → don't
  const loader = new DefaultResourceLoader({
    cwd: ctx.cwd,
    noExtensions: extensions === false,
    noSkills: skills === false,
    noPromptTemplates: true,
    noThemes: true,
    systemPromptOverride: () => systemPrompt,
  });
  await loader.reload();

  // Resolve model: explicit option > config.model > parent model
  const model = options.model ?? resolveDefaultModel(
    ctx.model, ctx.modelRegistry, agentConfig?.model,
  );

  // Resolve thinking level: explicit option > agent config > undefined (inherit)
  const thinkingLevel = options.thinkingLevel ?? agentConfig?.thinking;

  const sessionOpts: Record<string, unknown> = {
    cwd: ctx.cwd,
    sessionManager: SessionManager.inMemory(ctx.cwd),
    settingsManager: SettingsManager.create(),
    modelRegistry: ctx.modelRegistry,
    model,
    tools,
    resourceLoader: loader,
  };
  if (thinkingLevel) {
    sessionOpts.thinkingLevel = thinkingLevel;
  }

  // createAgentSession's type signature may not include thinkingLevel yet
  const { session } = await createAgentSession(sessionOpts as Parameters<typeof createAgentSession>[0]);

  // Filter active tools: remove our own tools to prevent nesting,
  // and apply extension allowlist if specified
  if (extensions !== false) {
    const builtinToolNames = new Set(tools.map(t => t.name));
    const activeTools = session.getActiveToolNames().filter((t) => {
      if (EXCLUDED_TOOL_NAMES.includes(t)) return false;
      if (builtinToolNames.has(t)) return true;
      if (Array.isArray(extensions)) {
        return extensions.some(ext => t.startsWith(ext) || t.includes(ext));
      }
      return true;
    });
    session.setActiveToolsByName(activeTools);
  }

  options.onSessionCreated?.(session);

  // Track turns for graceful max_turns enforcement
  let turnCount = 0;
  const maxTurns = options.maxTurns ?? agentConfig?.maxTurns ?? defaultMaxTurns;
  let softLimitReached = false;
  let aborted = false;

  let currentMessageText = "";
  const unsubTurns = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "turn_end") {
      turnCount++;
      if (!softLimitReached && turnCount >= maxTurns) {
        softLimitReached = true;
        session.steer("You have reached your turn limit. Wrap up immediately — provide your final answer now.");
      } else if (softLimitReached && turnCount >= maxTurns + graceTurns) {
        aborted = true;
        session.abort();
      }
    }
    if (event.type === "message_start") {
      currentMessageText = "";
    }
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      currentMessageText += event.assistantMessageEvent.delta;
      options.onTextDelta?.(event.assistantMessageEvent.delta, currentMessageText);
    }
    if (event.type === "tool_execution_start") {
      options.onToolActivity?.({ type: "start", toolName: event.toolName });
    }
    if (event.type === "tool_execution_end") {
      options.onToolActivity?.({ type: "end", toolName: event.toolName });
    }
  });

  const collector = collectResponseText(session);
  const cleanupAbort = forwardAbortSignal(session, options.signal);

  // Build the effective prompt: optionally prepend parent context
  let effectivePrompt = prompt;
  if (options.inheritContext) {
    const parentContext = buildParentContext(ctx);
    if (parentContext) {
      effectivePrompt = parentContext + prompt;
    }
  }

  try {
    await session.prompt(effectivePrompt);
  } finally {
    unsubTurns();
    collector.unsubscribe();
    cleanupAbort();
  }

  return { responseText: collector.getText(), session, aborted, steered: softLimitReached };
}

/**
 * Send a new prompt to an existing session (resume).
 */
export async function resumeAgent(
  session: AgentSession,
  prompt: string,
  options: { onToolActivity?: (activity: ToolActivity) => void; signal?: AbortSignal } = {},
): Promise<string> {
  const collector = collectResponseText(session);
  const cleanupAbort = forwardAbortSignal(session, options.signal);

  const unsubToolUse = options.onToolActivity
    ? session.subscribe((event: AgentSessionEvent) => {
        if (event.type === "tool_execution_start") options.onToolActivity!({ type: "start", toolName: event.toolName });
        if (event.type === "tool_execution_end") options.onToolActivity!({ type: "end", toolName: event.toolName });
      })
    : () => {};

  try {
    await session.prompt(prompt);
  } finally {
    collector.unsubscribe();
    unsubToolUse();
    cleanupAbort();
  }

  return collector.getText();
}

/**
 * Send a steering message to a running subagent.
 * The message will interrupt the agent after its current tool execution.
 */
export async function steerAgent(
  session: AgentSession,
  message: string,
): Promise<void> {
  await session.steer(message);
}

/**
 * Get the subagent's conversation messages as formatted text.
 */
export function getAgentConversation(session: AgentSession): string {
  const parts: string[] = [];

  for (const msg of session.messages) {
    if (msg.role === "user") {
      const text = typeof msg.content === "string"
        ? msg.content
        : extractText(msg.content);
      if (text.trim()) parts.push(`[User]: ${text.trim()}`);
    } else if (msg.role === "assistant") {
      const textParts: string[] = [];
      const toolCalls: string[] = [];
      for (const c of msg.content) {
        if (c.type === "text" && c.text) textParts.push(c.text);
        else if (c.type === "toolCall") toolCalls.push(`  Tool: ${(c as any).toolName ?? "unknown"}`);
      }
      if (textParts.length > 0) parts.push(`[Assistant]: ${textParts.join("\n")}`);
      if (toolCalls.length > 0) parts.push(`[Tool Calls]:\n${toolCalls.join("\n")}`);
    } else if (msg.role === "toolResult") {
      const text = extractText(msg.content);
      const truncated = text.length > 200 ? text.slice(0, 200) + "..." : text;
      parts.push(`[Tool Result (${msg.toolName})]: ${truncated}`);
    }
  }

  return parts.join("\n\n");
}
