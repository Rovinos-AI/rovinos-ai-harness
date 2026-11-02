// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import axe from "axe-core";
import { createAppTelemetry, type AppTelemetry } from "@rovinos/app-telemetry";
import { RunStatus, type RunConsoleDetail, type RunConsoleList } from "@rovinos/schemas/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRunsConsoleView, type RunsConsoleBridge } from "./view.js";

type SpanNames = readonly ["ui.render", "ui.error", "ui.interaction"];
type TestTelemetry = AppTelemetry<SpanNames>;
const spans: SpanNames = ["ui.render", "ui.error", "ui.interaction"];
const firstRunId = "00000000000000000000000001";
const secondRunId = "00000000000000000000000002";
const approvalId = "00000000000000000000000003";
const originalVisibilityState = Object.getOwnPropertyDescriptor(document, "visibilityState");

function runList(count = 1, pendingApprovals = 0, pendingInputs = 0): RunConsoleList {
  return {
    runs: Array.from({ length: count }, (_, index) => ({
      runId: index === 0 ? firstRunId : secondRunId,
      status: (pendingApprovals > 0 || pendingInputs > 0) && index === 0 ? "suspended" : "running",
      createdAt: 1000,
      lastTs: 2000,
      lastSeq: 3,
      steps: index + 1,
      pendingApprovals: index === 0 ? pendingApprovals : 0,
      pendingInputs: index === 0 ? pendingInputs : 0,
    })),
  };
}

function runDetail(canary?: string, pendingInputs = 0): RunConsoleDetail {
  return {
    runId: firstRunId,
    status: "suspended",
    steps: 4,
    usage: { inputTokens: 12, outputTokens: 34, costMicros: 56 },
    pendingApprovals: [
      {
        approvalId,
        toolId: "tool.call",
        ruleId: "policy.review",
        expiresAt: 10_000,
      },
    ],
    pendingInputs,
    ...(canary === undefined ? {} : { recentEvents: [{ content: canary }] }),
  };
}

function deferred<T>() {
  let fulfill: (value: T) => void = () => undefined;
  let deferReject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    fulfill = resolve;
    deferReject = reject;
  });
  return { promise, resolve: fulfill, reject: deferReject };
}

function createTelemetry() {
  const emitted: unknown[] = [];
  const telemetry: TestTelemetry = createAppTelemetry({
    bridge: {
      callTool: (_name, args) => {
        emitted.push(...args.spans);
        return Promise.resolve({ content: [] });
      },
    },
    hostReady: Promise.resolve(),
    manifest: { spans },
  });
  return { telemetry, emitted };
}

async function setup(
  input: {
    readonly list?: unknown;
    readonly detail?: unknown;
    readonly listError?: boolean;
    readonly now?: () => number;
    readonly listCall?: (
      args: Record<string, unknown>,
    ) => Promise<{ readonly structuredContent?: unknown }>;
    readonly detailCall?: (
      args: Record<string, unknown>,
    ) => Promise<{ readonly structuredContent?: unknown }>;
  } = {},
) {
  document.documentElement.lang = "en";
  document.title = "Runs";
  const calls: { readonly name: string; readonly args: Record<string, unknown> }[] = [];
  const openApproval = vi.fn(() => Promise.resolve());
  const bridge: RunsConsoleBridge = {
    callTool: (name, args) => {
      calls.push({ name, args });
      if (name === "harness.runs.list") {
        if (input.listCall !== undefined) {
          return input.listCall(args);
        }
        if (input.listError === true) {
          return Promise.reject(new Error("SYNTHETIC_BRIDGE_CANARY"));
        }
        return Promise.resolve({ structuredContent: input.list ?? runList() });
      }
      if (input.detailCall !== undefined) {
        return input.detailCall(args);
      }
      return Promise.resolve({ structuredContent: input.detail ?? runDetail() });
    },
    openApproval,
  };
  const { telemetry, emitted } = createTelemetry();
  const view = createRunsConsoleView(document.body, {
    bridge,
    telemetry,
    now: input.now ?? (() => 10_000),
  });
  await vi.waitFor(() => {
    expect(telemetry.active).toBe(true);
  });
  return { view, calls, openApproval, telemetry, emitted };
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

describe("runs console view", () => {
  it("renders the empty state with accessible landmarks and a live region", async () => {
    const { view } = await setup({ list: { runs: [] } });
    expect(document.querySelector("main h1")?.textContent).toBe("Runs");
    expect(document.querySelector('[role="status"]')?.textContent).toBe("Run list updated.");
    expect(document.querySelector('[role="status"]')?.getAttribute("aria-live")).toBe("polite");
    expect(document.body.textContent).toContain("No runs found");
    const result = await axe.run(document, { rules: { "color-contrast": { enabled: false } } });
    expect(result.violations).toEqual([]);
    view.dispose();
  });

  it("renders a long semantic table with status, age, steps, and approval badge", async () => {
    const { view } = await setup({ list: runList(40, 2, 1) });
    expect(document.querySelectorAll("tbody tr")).toHaveLength(40);
    expect(document.querySelector("caption")?.textContent).toBe("Runs");
    expect(document.querySelector("tbody th[scope=row]")?.textContent).toBe(firstRunId);
    expect(document.querySelector(".status-warning")?.textContent).toBe("suspended");
    expect(document.body.textContent).toContain("9 seconds ago");
    expect(document.body.textContent).toContain("Needs approval (2)");
    expect(document.body.textContent).toContain("Needs input (1)");
    const result = await axe.run(document, { rules: { "color-contrast": { enabled: false } } });
    expect(result.violations).toEqual([]);
    view.dispose();
  });

  it("renders each run status with its theme badge and formats longer ages", async () => {
    const statuses = RunStatus.options;
    const now = 90_000_000;
    const list: RunConsoleList = {
      runs: runList(statuses.length).runs.map((run, index) => ({
        ...run,
        status: statuses[index] ?? "pending",
        createdAt:
          [now - 1_000, now - 60_000, now - 3_600_000, now - 86_400_000, now, 0][index] ?? 0,
      })),
    };
    const { view } = await setup({ list, now: () => now });
    expect(document.querySelectorAll(".status-warning")).toHaveLength(2);
    expect(document.querySelectorAll(".status-success")).toHaveLength(1);
    expect(document.querySelectorAll(".status-danger")).toHaveLength(1);
    expect(document.querySelectorAll(".status-info")).toHaveLength(1);
    expect(document.querySelectorAll(".status-neutral")).toHaveLength(1);
    expect(document.body.textContent).toContain("1 second ago");
    expect(document.body.textContent).toContain("1 minute ago");
    expect(document.body.textContent).toContain("1 hour ago");
    expect(document.body.textContent).toContain("yesterday");
    document.documentElement.lang = "invalid_locale";
    await view.refresh();
    expect(document.body.textContent).toContain("yesterday");
    view.dispose();
  });

  it("filters by a status through the app-visible list tool and refreshes on demand", async () => {
    const { view, calls } = await setup();
    const filter = document.querySelector("select");
    if (filter === null) {
      throw new Error("Expected the status filter");
    }
    filter.value = "failed";
    filter.dispatchEvent(new Event("change"));
    await vi.waitFor(() => {
      expect(calls).toContainEqual({
        name: "harness.runs.list",
        args: { limit: 20, status: "failed" },
      });
    });
    document.querySelector("button")?.click();
    await vi.waitFor(() => {
      expect(calls.filter(({ name }) => name === "harness.runs.list")).toHaveLength(3);
    });
    view.dispose();
  });

  it("aggregates click telemetry and flushes it when the document becomes hidden", async () => {
    const { view, telemetry, emitted } = await setup();
    const refreshButton = document.querySelector("button");
    refreshButton?.click();
    refreshButton?.click();
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() => {
      expect(emitted).toContainEqual(
        expect.objectContaining({ name: "ui.interaction", kind: "click", count: 2 }),
      );
    });
    view.dispose();
    await telemetry.dispose();
  });

  it("loads metadata detail only and opens its pending approval through the host bridge", async () => {
    const canary = "SYNTHETIC_EVENT_CONTENT_CANARY";
    const { view, calls, openApproval, emitted } = await setup({
      list: runList(1, 1),
      detail: runDetail(canary, 2),
    });
    const approvalButton = [...document.querySelectorAll("button")].find((button) =>
      button.textContent.includes("Needs approval"),
    );
    approvalButton?.click();
    await vi.waitFor(() => {
      expect(openApproval).toHaveBeenCalledWith(approvalId);
    });
    const detailButton = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "View details",
    );
    detailButton?.click();
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("Input tokens");
    });
    expect(document.body.textContent).toContain("Needs input (2)");
    expect(calls).toContainEqual({
      name: "harness.runs.get",
      args: { runId: firstRunId },
    });
    expect(document.body.textContent).toContain("12");
    expect(document.body.textContent).not.toContain(canary);
    expect(JSON.stringify(emitted)).not.toContain(canary);
    view.dispose();
  });

  it("preserves a focused row action and horizontal scroll position across polling", async () => {
    const { view } = await setup({ list: runList(1, 1) });
    const wrapper = document.querySelector<HTMLElement>(".table-scroll");
    const approvalButton = document.querySelector<HTMLButtonElement>(
      'button[data-run-action="approval"]',
    );
    if (wrapper === null || approvalButton === null) {
      throw new Error("Expected the scroll wrapper and approval action.");
    }
    wrapper.scrollLeft = 47;
    approvalButton.focus();

    await view.refresh();

    expect(document.activeElement).toBe(
      document.querySelector('button[data-run-action="approval"]'),
    );
    expect(document.querySelector<HTMLElement>(".table-scroll")?.scrollLeft).toBe(47);
    view.dispose();
  });

  it("refreshes on run subscriptions without scheduling polling and unsubscribes on dispose", async () => {
    vi.useFakeTimers();
    let onUpdate: (() => void) | undefined;
    const unsubscribe = vi.fn();
    const calls: string[] = [];
    const { telemetry } = createTelemetry();
    const view = createRunsConsoleView(document.body, {
      bridge: {
        callTool: (name) => {
          calls.push(name);
          return Promise.resolve({ structuredContent: runList() });
        },
        subscribeRuns: (callback) => {
          onUpdate = callback;
          return unsubscribe;
        },
        openApproval: () => Promise.resolve(),
      },
      telemetry,
    });
    await vi.waitFor(() => {
      expect(calls).toHaveLength(1);
    });

    await vi.advanceTimersByTimeAsync(15_000);
    expect(calls).toHaveLength(1);
    onUpdate?.();
    await vi.waitFor(() => {
      expect(calls).toHaveLength(2);
    });
    view.dispose();
    expect(unsubscribe).toHaveBeenCalledOnce();
    await telemetry.dispose();
  });

  it("resumes polling when a run subscription closes", async () => {
    vi.useFakeTimers();
    let onClose: (() => void) | undefined;
    const calls: string[] = [];
    const { telemetry } = createTelemetry();
    const view = createRunsConsoleView(document.body, {
      bridge: {
        callTool: (name) => {
          calls.push(name);
          return Promise.resolve({ structuredContent: runList() });
        },
        subscribeRuns: (_onUpdate, onError) => {
          onClose = onError;
          return () => undefined;
        },
        openApproval: () => Promise.resolve(),
      },
      telemetry,
    });
    await vi.waitFor(() => {
      expect(calls).toHaveLength(1);
    });

    onClose?.();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(calls).toHaveLength(2);
    view.dispose();
    await telemetry.dispose();
  });

  it("falls back to polling when the host cannot establish run subscriptions", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const { telemetry } = createTelemetry();
    const view = createRunsConsoleView(document.body, {
      bridge: {
        callTool: (name) => {
          calls.push(name);
          return Promise.resolve({ structuredContent: runList() });
        },
        subscribeRuns: () => {
          throw new Error("subscription_unavailable");
        },
        openApproval: () => Promise.resolve(),
      },
      telemetry,
    });
    await vi.waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(calls).toHaveLength(2);
    view.dispose();
    await telemetry.dispose();
  });

  it("moves focus to the list region when its focused run disappears", async () => {
    let currentList = runList(1, 1);
    const { view } = await setup({
      listCall: () => Promise.resolve({ structuredContent: currentList }),
    });
    document.querySelector<HTMLButtonElement>('button[data-run-action="approval"]')?.focus();
    currentList = { runs: [] };

    await view.refresh();

    expect(document.activeElement).toBe(document.querySelector('main section[aria-label="Runs"]'));
    view.dispose();
  });

  it("ignores an earlier detail response that resolves after the latest selection", async () => {
    const first = deferred<{ readonly structuredContent?: unknown }>();
    const second = deferred<{ readonly structuredContent?: unknown }>();
    const firstRun = runList(1).runs[0];
    if (firstRun === undefined) {
      throw new Error("Expected the first run.");
    }
    const runs: RunConsoleList = {
      runs: [
        {
          ...firstRun,
        },
        {
          ...firstRun,
          runId: secondRunId,
        },
      ],
    };
    const { view } = await setup({
      list: runs,
      detailCall: (args) => (args.runId === firstRunId ? first.promise : second.promise),
    });
    document
      .querySelector<HTMLButtonElement>(
        `tr[data-run-id="${firstRunId}"] [data-run-action="details"]`,
      )
      ?.click();
    document
      .querySelector<HTMLButtonElement>(
        `tr[data-run-id="${secondRunId}"] [data-run-action="details"]`,
      )
      ?.click();
    second.resolve({
      structuredContent: {
        ...runDetail(),
        runId: secondRunId,
        usage: { inputTokens: 200, outputTokens: 3, costMicros: 4 },
      },
    });
    await vi.waitFor(() => {
      expect(document.querySelector("dl")?.textContent).toContain("200");
    });
    first.resolve({
      structuredContent: {
        ...runDetail(),
        usage: { inputTokens: 100, outputTokens: 3, costMicros: 4 },
      },
    });
    await Promise.resolve();

    expect(document.querySelector("dl")?.textContent).toContain("200");
    expect(document.querySelector("dl")?.textContent).not.toContain("100");
    view.dispose();
  });

  it("ignores an obsolete detail failure after a newer selection succeeds", async () => {
    const first = deferred<{ readonly structuredContent?: unknown }>();
    const second = deferred<{ readonly structuredContent?: unknown }>();
    const firstRun = runList(1).runs[0];
    if (firstRun === undefined) {
      throw new Error("Expected the first run.");
    }
    const { view } = await setup({
      list: {
        runs: [{ ...firstRun }, { ...firstRun, runId: secondRunId }],
      },
      detailCall: (args) => (args.runId === firstRunId ? first.promise : second.promise),
    });
    document
      .querySelector<HTMLButtonElement>(
        `tr[data-run-id="${firstRunId}"] [data-run-action="details"]`,
      )
      ?.click();
    document
      .querySelector<HTMLButtonElement>(
        `tr[data-run-id="${secondRunId}"] [data-run-action="details"]`,
      )
      ?.click();
    second.resolve({
      structuredContent: {
        ...runDetail(),
        runId: secondRunId,
        usage: { inputTokens: 200, outputTokens: 3, costMicros: 4 },
      },
    });
    await vi.waitFor(() => {
      expect(document.querySelector("dl")?.textContent).toContain("200");
    });
    first.reject(new Error("SYNTHETIC_STALE_DETAIL_ERROR"));
    await Promise.resolve();

    expect(document.querySelector("dl")?.textContent).toContain("200");
    expect(document.body.textContent).not.toContain("temporarily unavailable");
    view.dispose();
  });

  it("loads past empty intermediate pages until a visible page is available", async () => {
    const calls: Record<string, unknown>[] = [];
    const firstRun = runList(1).runs[0];
    if (firstRun === undefined) {
      throw new Error("Expected a test run.");
    }
    const pages = new Map<string, RunConsoleList>([
      ["", { runs: runList(1).runs, nextCursor: "cursor-1" }],
      ["cursor-1", { runs: [], nextCursor: "cursor-2" }],
      ["cursor-2", { runs: [{ ...firstRun, runId: secondRunId }] }],
    ]);
    const { view } = await setup({
      listCall: (args) => {
        calls.push(args);
        const cursor = typeof args.cursor === "string" ? args.cursor : "";
        const page = pages.get(cursor);
        if (page === undefined) {
          throw new Error("Unexpected cursor.");
        }
        return Promise.resolve({ structuredContent: page });
      },
    });
    document.querySelector<HTMLButtonElement>("button:nth-of-type(2)")?.click();
    await vi.waitFor(() => {
      expect(document.querySelectorAll("tbody tr")).toHaveLength(2);
    });

    expect(calls.map((args) => args.cursor)).toEqual([undefined, "cursor-1", "cursor-2"]);
    view.dispose();
  });

  it("buffers the first render span until the telemetry bridge activates", async () => {
    const hostReady = deferred<undefined>();
    const emitted: unknown[] = [];
    const telemetry: TestTelemetry = createAppTelemetry({
      bridge: {
        callTool: (_name, args) => {
          emitted.push(...args.spans);
          return Promise.resolve({ content: [] });
        },
      },
      hostReady: hostReady.promise,
      manifest: { spans },
    });
    const view = createRunsConsoleView(document.body, {
      bridge: {
        callTool: () => Promise.resolve({ structuredContent: runList() }),
        openApproval: () => Promise.resolve(),
      },
      telemetry,
    });
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("Run list updated.");
    });
    expect(emitted).toEqual([]);
    hostReady.resolve(undefined);
    await vi.waitFor(() => {
      expect(emitted).toContainEqual(expect.objectContaining({ name: "ui.render" }));
    });
    view.dispose();
    await telemetry.dispose();
  });

  it("ignores a delayed list response after the status filter changes", async () => {
    const initial = deferred<{ readonly structuredContent?: unknown }>();
    const calls: Record<string, unknown>[] = [];
    const { view } = await setup({
      listCall: (args) => {
        calls.push(args);
        return calls.length === 1
          ? initial.promise
          : Promise.resolve({
              structuredContent: {
                runs: [{ ...runList(1).runs[0], status: "failed" }],
              },
            });
      },
    });
    const filter = document.querySelector("select");
    if (filter === null) {
      throw new Error("Expected the status filter.");
    }
    filter.value = "failed";
    filter.dispatchEvent(new Event("change"));
    initial.resolve({ structuredContent: { runs: runList(1).runs } });

    await vi.waitFor(() => {
      expect(document.querySelector(".status-danger")?.textContent).toBe("failed");
    });
    expect(calls.map((args) => args.status)).toEqual([undefined, "failed"]);
    expect(document.querySelector(".status-info")).toBeNull();
    view.dispose();
  });

  it("ignores a delayed list error after the status filter changes", async () => {
    const initial = deferred<{ readonly structuredContent?: unknown }>();
    const calls: Record<string, unknown>[] = [];
    const { view } = await setup({
      listCall: (args) => {
        calls.push(args);
        return calls.length === 1
          ? initial.promise
          : Promise.resolve({
              structuredContent: {
                runs: [{ ...runList(1).runs[0], status: "failed" }],
              },
            });
      },
    });
    const filter = document.querySelector("select");
    if (filter === null) {
      throw new Error("Expected the status filter.");
    }
    filter.value = "failed";
    filter.dispatchEvent(new Event("change"));
    initial.reject(new Error("SYNTHETIC_STALE_FILTER_ERROR"));

    await vi.waitFor(() => {
      expect(document.querySelector(".status-danger")?.textContent).toBe("failed");
    });
    expect(document.body.textContent).not.toContain("temporarily unavailable");
    expect(calls.map((args) => args.status)).toEqual([undefined, "failed"]);
    view.dispose();
  });

  it("does not open an approval when the latest run detail has no pending approval", async () => {
    const { view, openApproval } = await setup({
      list: runList(1, 1),
      detail: { ...runDetail(), pendingApprovals: [] },
    });
    [...document.querySelectorAll("button")]
      .find((button) => button.textContent.includes("Needs approval"))
      ?.click();
    await vi.waitFor(() => {
      expect(document.querySelector('[role="status"]')?.textContent).toBe("Run list updated.");
    });
    expect(openApproval).not.toHaveBeenCalled();
    view.dispose();
  });

  it("renders hostile ids and statuses as a generic error instead of executable markup", async () => {
    const hostile = "<img src=x onerror=alert(1)>";
    const { view, emitted } = await setup({
      list: {
        runs: [
          {
            runId: hostile,
            status: hostile,
            createdAt: 1,
            lastTs: 1,
            lastSeq: 0,
            steps: 0,
            pendingApprovals: 0,
          },
        ],
      },
    });
    expect(document.body.textContent).toContain("Run metadata is temporarily unavailable.");
    expect(document.querySelectorAll("img, [onerror]")).toHaveLength(0);
    expect(document.body.textContent).not.toContain(hostile);
    expect(JSON.stringify(emitted)).not.toContain(hostile);
    view.dispose();
  });

  it("backs polling off after bridge errors and resumes at the bounded interval", async () => {
    vi.useFakeTimers();
    let fail = true;
    const calls: string[] = [];
    const { telemetry, emitted } = createTelemetry();
    const view = createRunsConsoleView(document.body, {
      bridge: {
        callTool: (name) => {
          calls.push(name);
          if (name === "harness.runs.list" && fail) {
            return Promise.reject(new Error("SYNTHETIC_BRIDGE_CANARY"));
          }
          return Promise.resolve({
            structuredContent: name === "harness.runs.list" ? runList() : runDetail(),
          });
        },
        openApproval: () => Promise.resolve(),
      },
      telemetry,
      now: () => 10_000,
    });
    await vi.waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    expect(document.body.textContent).toContain("Run metadata is temporarily unavailable.");
    expect(document.body.textContent).not.toContain("SYNTHETIC_BRIDGE_CANARY");
    expect(JSON.stringify(emitted)).not.toContain("SYNTHETIC_BRIDGE_CANARY");
    await vi.advanceTimersByTimeAsync(9_999);
    expect(calls).toHaveLength(1);
    fail = false;
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => {
      expect(calls).toHaveLength(2);
    });
    view.dispose();
    await telemetry.dispose();
  });

  it("pauses while hidden and immediately refreshes when visible again", async () => {
    vi.useFakeTimers();
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    const calls: string[] = [];
    const { telemetry } = createTelemetry();
    const view = createRunsConsoleView(document.body, {
      bridge: {
        callTool: (name) => {
          calls.push(name);
          return Promise.resolve({
            structuredContent: name === "harness.runs.list" ? runList() : runDetail(),
          });
        },
        openApproval: () => Promise.resolve(),
      },
      telemetry,
    });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(calls).toEqual([]);
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(calls).toHaveLength(1);
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() => {
      expect(calls).toHaveLength(2);
    });
    view.dispose();
    await telemetry.dispose();
  });
});
