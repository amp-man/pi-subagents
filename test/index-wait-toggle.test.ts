import { beforeEach, describe, expect, it, vi } from "vitest";
import { setAllowWait } from "../src/agent-runner.js";

const { records } = vi.hoisted(() => ({
  records: new Map<string, any>(),
}));

vi.mock("../src/agent-manager.js", () => {
  class MockAgentManager {
    getRecord(id: string) {
      return records.get(id);
    }

    listAgents() {
      return [];
    }

    waitForAll() {
      return Promise.resolve();
    }

    hasRunning() {
      return false;
    }

    spawn() {
      return "mock-agent-id";
    }

    clearCompleted() {}

    abortAll() {}

    dispose() {}

    getMaxConcurrent() {
      return 4;
    }

    setMaxConcurrent(_n: number) {}
  }

  return {
    AgentManager: MockAgentManager,
  };
});

vi.mock("../src/cross-extension-rpc.js", () => ({
  registerRpcHandlers: () => ({
    unsubPing: () => {},
    unsubSpawn: () => {},
  }),
}));

import extension from "../src/index.js";

function createRunningRecord(id: string) {
  let resolvePromise: (() => void) | undefined;
  const record: any = {
    id,
    type: "general-purpose",
    description: "test",
    status: "running",
    toolUses: 0,
    startedAt: Date.now(),
    resultConsumed: false,
  };

  record.promise = new Promise<void>((resolve) => {
    resolvePromise = () => {
      record.status = "completed";
      record.result = "done";
      record.completedAt = Date.now();
      resolve();
    };
  });

  return { record, resolvePromise: resolvePromise! };
}

describe("get_subagent_result wait guard", () => {
  let getSubagentResultTool: any;

  beforeEach(() => {
    records.clear();
    setAllowWait(false);
    getSubagentResultTool = undefined;

    const pi: any = {
      registerMessageRenderer: vi.fn(),
      registerTool: vi.fn((tool: any) => {
        if (tool.name === "get_subagent_result") {
          getSubagentResultTool = tool;
        }
      }),
      registerCommand: vi.fn(),
      on: vi.fn(),
      appendEntry: vi.fn(),
      sendMessage: vi.fn(),
      events: {
        emit: vi.fn(),
        on: vi.fn(() => () => {}),
      },
    };

    extension(pi);
  });

  it("blocks wait=true in the main conversation by default", async () => {
    records.set("agent-1", {
      id: "agent-1",
      type: "general-purpose",
      description: "test",
      status: "completed",
      toolUses: 0,
      startedAt: Date.now(),
      completedAt: Date.now(),
      result: "done",
    });

    const result = await getSubagentResultTool.execute(
      "tool-call-id",
      { agent_id: "agent-1", wait: true },
      undefined,
      undefined,
      { sessionManager: { getSessionFile: () => ".pi/sessions/main-session.json" } },
    );

    expect(result.content[0].text).toBe(
      "The wait option is disabled for the main conversation to prevent blocking. Use wait: false and rely on asynchronous notifications. (You can enable it in /agents -> Settings).",
    );
  });

  it("allows wait=true in the main conversation when enabled", async () => {
    setAllowWait(true);
    const { record, resolvePromise } = createRunningRecord("agent-2");
    records.set("agent-2", record);

    let settled = false;
    const execPromise = getSubagentResultTool
      .execute(
        "tool-call-id",
        { agent_id: "agent-2", wait: true },
        undefined,
        undefined,
        { sessionManager: { getSessionFile: () => ".pi/sessions/main-session.json" } },
      )
      .then((result: any) => {
        settled = true;
        return result;
      });

    await Promise.resolve();
    expect(settled).toBe(false);
    expect(record.resultConsumed).toBe(true);

    resolvePromise();
    const result = await execPromise;

    expect(result.content[0].text).toContain("done");
  });

  it("does not block wait=true for subagent sessions", async () => {
    const { record, resolvePromise } = createRunningRecord("agent-3");
    records.set("agent-3", record);

    const execPromise = getSubagentResultTool.execute(
      "tool-call-id",
      { agent_id: "agent-3", wait: true },
      undefined,
      undefined,
      { sessionManager: { getSessionFile: () => ".pi/agent/sessions/subagent-session.json" } },
    );

    resolvePromise();
    const result = await execPromise;

    expect(result.content[0].text).toContain("done");
  });
});
