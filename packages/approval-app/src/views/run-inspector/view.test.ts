// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import axe from "axe-core";
import { createAppTelemetry, type AppTelemetry } from "@rovinos/app-telemetry";
import type { RunContent, RunTimeline } from "@rovinos/schemas/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRunInspectorView, type RunInspectorBridge } from "./view.js";

type TestTelemetry = AppTelemetry<readonly ["ui.render", "ui.error", "ui.interaction"]>;
const runId = "00000000000000000000000001";
const childRunId = "00000000000000000000000002";
const approvalId = "00000000000000000000000003";
const inputId = "00000000000000000000000004";
const originalVisibilityState = Object.getOwnPropertyDescriptor(document, "visibilityState");

function timeline(id: string, steps: RunTimeline["steps"] = []): RunTimeline {
  return {
    runId: id,
    status: "running",
    lastSeq: steps.at(-1)?.lastSeq ?? 1,
    steps,
    usage: {
      steps: 2,
      inputTokens: 10,
      outputTokens: 20,
      cost: {
        version: 1,
        state: "known",
        knownMicros: 3,
        estimatedMicros: 0,
        partialMicros: 0,
        knownCount: 1,
        estimatedCount: 0,
        partialCount: 0,
        unknownCount: 0,
      },
    },
  };
}

function runSteps(): RunTimeline["steps"] {
  return [
    {
      type: "subagent_spawn",
      seq: 1,
      lastSeq: 1,
      startedAt: 1,
      status: "running",
      childRunId,
      role: "worker",
      maxSteps: 10,
      maxCostUsd: 0.01,
      maxWallClockMs: 1_000,
    },
    {
      type: "subagent_completion",
      seq: 4,
      lastSeq: 4,
      startedAt: 1,
      endedAt: 501,
      durationMs: 500,
      status: "completed",
      childRunId,
      outcome: "completed",
      stepsUsed: 4,
      costMicros: 5_000,
    },
    {
      type: "approval_wait",
      seq: 2,
      lastSeq: 2,
      startedAt: 2,
      status: "pending",
      approvalId,
    },
    {
      type: "input_wait",
      seq: 3,
      lastSeq: 3,
      startedAt: 3,
      status: "pending",
      requestId: inputId,
    },
  ];
}

function content(id: string): RunContent {
  return {
    runId: id,
    truncated: false,
    events: [
      {
        seq: 1,
        type: "model_request",
        value: [
          { role: "user", parts: [{ type: "text", text: '<img src=x onerror="alert(1)">' }] },
        ],
      },
    ],
  };
}

function createTelemetry(): TestTelemetry {
  return createAppTelemetry({
    bridge: { callTool: () => Promise.resolve({ content: [] }) },
    hostReady: Promise.resolve(),
    manifest: { spans: ["ui.render", "ui.error", "ui.interaction"] },
  });
}

function buttonWithText(text: string): HTMLButtonElement {
  const button = [...document.querySelectorAll("button")].find((item) =>
    item.textContent.includes(text),
  );
  if (button === undefined) {
    throw new Error(`Expected a button containing "${text}".`);
  }
  return button;
}

function setup(
  input: {
    readonly subscribe?: boolean;
    readonly timelineByRun?: (id: string) => RunTimeline;
    readonly contentResponse?: {
      readonly isError?: boolean;
      readonly structuredContent?: unknown;
    };
  } = {},
) {
  document.title = "Run inspector";
  document.documentElement.lang = "en";
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  let update: (() => void) | undefined;
  let subscriptionError: (() => void) | undefined;
  const openApproval = vi.fn(() => Promise.resolve());
  const openInput = vi.fn(() => Promise.resolve());
  const bridge: RunInspectorBridge = {
    callTool: (name, args) => {
      calls.push({ name, args });
      if (name === "get_run_timeline") {
        return Promise.resolve({
          structuredContent:
            input.timelineByRun?.(String(args.runId)) ?? timeline(runId, runSteps()),
        });
      }
      if (name === "get_run") {
        return Promise.resolve({
          structuredContent: {
            runId: args.runId,
            createdAt: 0,
            status: "running",
            lastSeq: 1,
            lastTs: 1,
            steps: 2,
            usage: {
              inputTokens: 10,
              outputTokens: 20,
              cost: {
                version: 1,
                state: "known",
                knownMicros: 3,
                estimatedMicros: 0,
                partialMicros: 0,
                knownCount: 1,
                estimatedCount: 0,
                partialCount: 0,
                unknownCount: 0,
              },
            },
            pendingApprovals: [],
            pendingInputs: 0,
            recentEvents: [],
          },
        });
      }
      return Promise.resolve(
        input.contentResponse ?? { structuredContent: content(String(args.runId)) },
      );
    },
    ...(input.subscribe === false
      ? {}
      : {
          subscribeRuns: (onUpdate: () => void, onError: () => void) => {
            update = onUpdate;
            subscriptionError = onError;
            return () => {
              update = undefined;
              subscriptionError = undefined;
            };
          },
        }),
    openApproval,
    openInput,
  };
  const telemetry = createTelemetry();
  const view = createRunInspectorView(document.body, { bridge, runId, telemetry });
  return {
    view,
    calls,
    openApproval,
    openInput,
    telemetry,
    update: () => update?.(),
    subscriptionError: () => subscriptionError?.(),
  };
}

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
  if (originalVisibilityState === undefined) {
    Reflect.deleteProperty(document, "visibilityState");
  } else {
    Object.defineProperty(document, "visibilityState", originalVisibilityState);
  }
});

describe("run inspector view", () => {
  it("renders metadata accessibly and does not request content by default", async () => {
    const { view, calls } = setup();
    await vi.waitFor(() => {
      expect(
        document.querySelector('[aria-labelledby="run-inspector-timeline-heading"] ol'),
      ).not.toBeNull();
    });

    expect(document.querySelector("main h1")?.textContent).toBe("Run inspector");
    expect(document.body.textContent).toContain("10");
    expect(document.querySelectorAll("meter")).toHaveLength(3);
    expect(calls.map(({ name }) => name)).not.toContain("harness.runs.content");
    expect(document.querySelector("pre")).toBeNull();
    const result = await axe.run(document, { rules: { "color-contrast": { enabled: false } } });
    expect(result.violations).toEqual([]);
    view.dispose();
  });

  it("loads tokenized content only after an explicit action and keeps hostile text inert", async () => {
    const { view, calls } = setup();
    await vi.waitFor(() => {
      expect(calls).toHaveLength(2);
    });
    const button = buttonWithText("Show tokenized content");
    button.click();
    await vi.waitFor(() => {
      expect(document.querySelector("pre")).not.toBeNull();
    });

    expect(document.querySelector("pre")?.textContent).toContain("<img");
    expect(document.querySelector("pre img")).toBeNull();
    expect(calls.map(({ name }) => name)).toContain("harness.runs.content");
    view.dispose();
  });

  it("hides and restores already-loaded content without requesting it again", async () => {
    const { view, calls } = setup();
    await vi.waitFor(() => {
      expect(calls).toHaveLength(2);
    });
    buttonWithText("Show tokenized content").click();
    await vi.waitFor(() => {
      expect(document.querySelector("pre")).not.toBeNull();
    });

    buttonWithText("Hide tokenized content").click();
    expect(document.querySelector("pre")).toBeNull();
    buttonWithText("Show tokenized content").click();
    expect(document.querySelector("pre")?.textContent).toContain("<img");
    expect(calls.filter(({ name }) => name === "harness.runs.content")).toHaveLength(1);
    view.dispose();
  });

  it("shows a safe unavailable message when the content tool returns an error", async () => {
    const { view, calls } = setup({
      contentResponse: { isError: true },
    });
    await vi.waitFor(() => {
      expect(calls).toHaveLength(2);
    });
    buttonWithText("Show tokenized content").click();
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("Tokenized content is unavailable");
    });
    expect(document.querySelector("pre")).toBeNull();
    view.dispose();
  });

  it("navigates to subagents and opens pending approval and input items", async () => {
    const { view, calls, openApproval, openInput } = setup({
      timelineByRun: (id) => timeline(id, id === runId ? runSteps() : []),
    });
    await vi.waitFor(() => {
      expect(calls).toHaveLength(2);
    });
    await vi.waitFor(() => {
      expect(buttonWithText(childRunId)).toBeDefined();
    });
    buttonWithText(childRunId).click();
    await vi.waitFor(() => {
      expect(
        calls.some(({ name, args }) => name === "get_run_timeline" && args.runId === childRunId),
      ).toBe(true);
    });
    buttonWithText("Back to parent run").click();
    await vi.waitFor(() => {
      expect(
        calls.filter(({ name, args }) => name === "get_run_timeline" && args.runId === runId),
      ).toHaveLength(2);
    });
    await vi.waitFor(() => {
      expect(buttonWithText("approval wait")).toBeDefined();
    });
    buttonWithText("approval wait").click();
    buttonWithText(approvalId).click();
    buttonWithText(inputId).click();
    expect(openApproval).toHaveBeenCalledWith(approvalId);
    expect(openInput).toHaveBeenCalledWith(inputId);
    view.dispose();
  });

  it("refreshes on subscriptions and falls back to polling while visible", async () => {
    const live = setup();
    await vi.waitFor(() => {
      expect(live.calls).toHaveLength(2);
    });
    live.update();
    await vi.waitFor(() => {
      expect(live.calls).toHaveLength(4);
    });
    live.subscriptionError();
    live.view.dispose();

    vi.useFakeTimers();
    const fallback = setup({ subscribe: false });
    await vi.waitFor(() => {
      expect(fallback.calls).toHaveLength(2);
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => {
      expect(fallback.calls).toHaveLength(4);
    });
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(document.body.textContent).toContain("paused while this view is hidden");
    fallback.view.dispose();
  });
});
