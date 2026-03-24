import { beforeEach, describe, expect, it, vi } from "vitest";
import { setAllowBlocking } from "../src/agent-runner.js";

const { records, spawnMock, spawnAndWaitMock } = vi.hoisted(() => ({
  records: new Map<string, any>(),
  spawnMock: vi.fn(() => "mock-agent-id"),
  spawnAndWaitMock: vi.fn(async () => ({
    id: "mock-agent-id",
    type: "general-purpose",
    description: "test",
    status: "completed",
    toolUses: 0,
    startedAt: Date.now(),
    completedAt: Date.now(),
    result: "done",
  })),
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

    spawn(...args: any[]) {
      return spawnMock(...args);
    }

    spawnAndWait(...args: any[]) {
      return spawnAndWaitMock(...args);
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

function createAgentToolCtx(sessionFile: string) {
  return {
    ui: {},
    cwd: process.cwd(),
    model: undefined,
    modelRegistry: { getAvailable: () => [], getAll: () => [] },
    sessionManager: {
      getSessionFile: () => sessionFile,
      getSessionId: () => "session-id",
    },
  };
}

describe("wait toggle guards", () => {
  let getSubagentResultTool: any;
  let agentTool: any;

  beforeEach(() => {
    records.clear();
    setAllowBlocking(false);
    getSubagentResultTool = undefined;
    agentTool = undefined;

    spawnMock.mockReset();
    spawnMock.mockReturnValue("mock-agent-id");
    spawnAndWaitMock.mockReset();
    spawnAndWaitMock.mockResolvedValue({
      id: "mock-agent-id",
      type: "general-purpose",
      description: "test",
      status: "completed",
      toolUses: 0,
      startedAt: Date.now(),
      completedAt: Date.now(),
      result: "done",
    });

    const pi: any = {
      registerMessageRenderer: vi.fn(),
      registerTool: vi.fn((tool: any) => {
        if (tool.name === "get_subagent_result") {
          getSubagentResultTool = tool;
        }
        if (tool.name === "Agent") {
          agentTool = tool;
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
      "Blocked: wait is disabled for the main conversation. Use wait: false or enable blocking in /agents -> Settings.",
    );
  });

  it("blocks wait=true for agent/sessions main conversation paths", async () => {
    records.set("agent-1b", {
      id: "agent-1b",
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
      { agent_id: "agent-1b", wait: true },
      undefined,
      undefined,
      { sessionManager: { getSessionFile: () => "/Users/ludwig/agent/sessions/main-session.json" } },
    );

    expect(result.content[0].text).toBe(
      "Blocked: wait is disabled for the main conversation. Use wait: false or enable blocking in /agents -> Settings.",
    );
  });

  it("allows wait=true in the main conversation when enabled", async () => {
    setAllowBlocking(true);
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

  it("does not block wait=true for temp agent/sessions paths", async () => {
    const { record, resolvePromise } = createRunningRecord("agent-4");
    records.set("agent-4", record);

    const execPromise = getSubagentResultTool.execute(
      "tool-call-id",
      { agent_id: "agent-4", wait: true },
      undefined,
      undefined,
      { sessionManager: { getSessionFile: () => "/var/tmp/agent/sessions/subagent-session.json" } },
    );

    resolvePromise();
    const result = await execPromise;

    expect(result.content[0].text).toContain("done");
  });

  it("blocks foreground Agent calls in the main conversation by default", async () => {
    const result = await agentTool.execute(
      "tool-call-id",
      {
        prompt: "Do work",
        description: "test",
        subagent_type: "general-purpose",
        run_in_background: false,
      },
      undefined,
      undefined,
      createAgentToolCtx(".pi/sessions/main-session.json"),
    );

    expect(result.content[0].text).toBe(
      "Blocked: foreground agent execution is disabled for the main conversation. Use run_in_background: true or enable blocking in /agents -> Settings.",
    );
    expect(spawnAndWaitMock).not.toHaveBeenCalled();
  });

  it("does not block background Agent calls in the main conversation", async () => {
    const result = await agentTool.execute(
      "tool-call-id",
      {
        prompt: "Do work",
        description: "test",
        subagent_type: "general-purpose",
        run_in_background: true,
      },
      undefined,
      undefined,
      createAgentToolCtx(".pi/sessions/main-session.json"),
    );

    expect(result.content[0].text).toContain("Agent started in background.");
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("allows foreground Agent calls in the main conversation when enabled", async () => {
    setAllowBlocking(true);

    const result = await agentTool.execute(
      "tool-call-id",
      {
        prompt: "Do work",
        description: "test",
        subagent_type: "general-purpose",
        run_in_background: false,
      },
      undefined,
      undefined,
      createAgentToolCtx(".pi/sessions/main-session.json"),
    );

    expect(spawnAndWaitMock).toHaveBeenCalledTimes(1);
    expect(result.content[0].text).toContain("Agent completed in");
  });
});
