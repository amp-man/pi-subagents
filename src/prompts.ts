/**
 * prompts.ts — System prompt builder for agents.
 */

import type { AgentConfig, EnvInfo } from "./types.js";

/**
 * Build the system prompt for an agent from its config.
 *
 * - "replace" mode: common header + config.systemPrompt
 * - "append" mode: common header + generic base + config.systemPrompt
 */
export function buildAgentPrompt(config: AgentConfig, cwd: string, env: EnvInfo): string {
  const commonHeader = `You are a pi coding agent sub-agent.
You have been invoked to handle a specific task autonomously.

# Environment
Working directory: ${cwd}
${env.isGitRepo ? `Git repository: yes\nBranch: ${env.branch}` : "Not a git repository"}
Platform: ${env.platform}`;

  if (config.promptMode === "append") {
    const genericBase = `

# Role
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
- Be concise but complete`;

    return commonHeader + genericBase + "\n\n" + config.systemPrompt;
  }

  // "replace" mode — header + the config's full system prompt
  return commonHeader + "\n\n" + config.systemPrompt;
}
