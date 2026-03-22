import { visibleWidth } from "@mariozechner/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import extension from "../src/index.js";

type Theme = {
  fg: (_color: string, text: string) => string;
  bold: (text: string) => string;
};

function getText(component: unknown): string {
  return ((component as { text?: string })?.text) ?? "";
}

function expectLinesWithinWidth(text: string, width: number): void {
  for (const line of text.split("\n")) {
    expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  }
}

describe("index render truncation", () => {
  const originalColumns = process.stdout.columns;
  const theme: Theme = {
    fg: (_color, text) => text,
    bold: (text) => text,
  };

  let agentTool: any;
  let notificationRenderer: any;

  beforeEach(() => {
    agentTool = undefined;
    notificationRenderer = undefined;
    (process.stdout as any).columns = 24;

    const pi: any = {
      registerMessageRenderer: vi.fn((customType: string, renderer: unknown) => {
        if (customType === "subagent-notification") {
          notificationRenderer = renderer;
        }
      }),
      registerTool: vi.fn((tool: unknown) => {
        if ((tool as { name?: string }).name === "Agent") {
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


  afterEach(() => {
    if (originalColumns === undefined) {
      delete (process.stdout as any).columns;
    } else {
      (process.stdout as any).columns = originalColumns;
    }
  });

  it("truncates subagent-notification renderer lines", () => {
    const rendered = notificationRenderer(
      {
        details: {
          id: "agent-1",
          description: "D".repeat(120),
          status: "completed",
          toolUses: 5,
          turnCount: 3,
          maxTurns: 10,
          totalTokens: 12_345,
          durationMs: 15_000,
          outputFile: "/very/long/path/" + "x".repeat(120),
          resultPreview: "R".repeat(140),
        },
      },
      { expanded: true },
      theme,
    );

    expectLinesWithinWidth(getText(rendered), 24);
  });

  it("truncates Agent renderCall output", () => {
    const rendered = agentTool.renderCall(
      {
        subagent_type: "general-purpose",
        description: "D".repeat(120),
      },
      theme,
    );

    expectLinesWithinWidth(getText(rendered), 24);
  });

  it("truncates Agent renderResult output across states", () => {
    const cases = [
      {
        result: { content: [{ type: "text", text: "T".repeat(140) }] },
        options: { expanded: false, isPartial: false },
      },
      {
        result: {
          content: [{ type: "text", text: "ignored" }],
          details: { status: "running", activity: "A".repeat(140), spinnerFrame: 0, toolUses: 1, tokens: "", durationMs: 0 },
        },
        options: { expanded: false, isPartial: true },
      },
      {
        result: {
          content: [{ type: "text", text: "ignored" }],
          details: { status: "background", agentId: "bg-" + "x".repeat(120), toolUses: 0, tokens: "", durationMs: 0 },
        },
        options: { expanded: false, isPartial: false },
      },
      {
        result: {
          content: [{ type: "text", text: "R".repeat(180) }],
          details: { status: "completed", toolUses: 1, tokens: "", durationMs: 12_000 },
        },
        options: { expanded: true, isPartial: false },
      },
      {
        result: {
          content: [{ type: "text", text: "ignored" }],
          details: { status: "stopped", toolUses: 1, tokens: "", durationMs: 0 },
        },
        options: { expanded: false, isPartial: false },
      },
      {
        result: {
          content: [{ type: "text", text: "ignored" }],
          details: { status: "error", error: "E".repeat(140), toolUses: 0, tokens: "", durationMs: 0 },
        },
        options: { expanded: false, isPartial: false },
      },
    ];

    for (const testCase of cases) {
      const rendered = agentTool.renderResult(testCase.result, testCase.options, theme);
      expectLinesWithinWidth(getText(rendered), 24);
    }
  });
});
