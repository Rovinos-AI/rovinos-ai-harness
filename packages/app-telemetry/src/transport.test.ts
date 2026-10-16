// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppSpan } from "@harness/schemas";
import { createAppTelemetry } from "./index.js";
import type { AppTelemetryBridge } from "./types.js";

const traceId = "1234567890abcdef1234567890abcdef";
const validTraceparent = `00-${traceId}-1234567890abcdef-01`;
type ToolCallArgs = Parameters<AppTelemetryBridge["callTool"]>;

function makeTelemetry(callTool: AppTelemetryBridge["callTool"]) {
  return createAppTelemetry({
    bridge: { callTool },
    manifest: { spans: ["ui.render", "ui.error", "ui.interaction"] as const },
    now: () => 10,
  });
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function waitForActive(telemetry: { readonly active: boolean }): Promise<void> {
  await vi.waitFor(() => {
    expect(telemetry.active).toBe(true);
  });
}

function dataCalls(callTool: { mock: { calls: readonly ToolCallArgs[] } }) {
  return callTool.mock.calls.map((call) => call[1]).filter(({ spans }) => spans.length > 0);
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("app telemetry transport", () => {
  it("activates only after host confirmation and exposes a valid trace id", async () => {
    const callTool = vi.fn((..._args: ToolCallArgs) =>
      Promise.resolve({ _meta: { traceparent: validTraceparent } }),
    );
    const telemetry = makeTelemetry(callTool);

    expect(telemetry.active).toBe(false);
    expect(telemetry.traceContext.traceId).toBeUndefined();
    await waitForActive(telemetry);

    expect(callTool).toHaveBeenCalledWith("harness.telemetry.emit", { spans: [] });
    expect(telemetry.traceContext.traceId).toBe(traceId);
    expect(Object.isFrozen(telemetry.traceContext)).toBe(true);
    telemetry.record("ui.render", {});
    await telemetry.flush();
    expect(dataCalls(callTool)).toHaveLength(1);
    expect(JSON.stringify(dataCalls(callTool))).not.toContain(validTraceparent);
    expect(JSON.stringify(dataCalls(callTool))).not.toContain(traceId);
  });

  it.each([
    ["invalid", "00-invalid"],
    ["absent", undefined],
    ["non-string", 1],
    ["zero trace id", `00-${"0".repeat(32)}-1234567890abcdef-01`],
    ["zero span id", `00-${traceId}-${"0".repeat(16)}-01`],
  ])("does not expose an %s traceparent", async (_case, traceparent) => {
    const callTool = vi.fn((..._args: ToolCallArgs) =>
      Promise.resolve({
        ...(traceparent === undefined ? {} : { _meta: { traceparent } }),
      }),
    );
    const telemetry = makeTelemetry(callTool);
    await waitForActive(telemetry);
    expect(telemetry.traceContext.traceId).toBeUndefined();
  });

  it("stays inactive after activation errors and keeps every method silent", async () => {
    const callTool = vi.fn((..._args: ToolCallArgs) =>
      Promise.reject(new Error("host unavailable")),
    );
    const telemetry = makeTelemetry(callTool);
    await settle();

    expect(telemetry.active).toBe(false);
    expect(() => {
      telemetry.record("ui.render", {});
    }).not.toThrow();
    expect(() => {
      telemetry.start("ui.render").end();
    }).not.toThrow();
    await expect(telemetry.flush()).resolves.toBeUndefined();
    await expect(telemetry.dispose()).resolves.toBeUndefined();
    expect(telemetry.stats()).toEqual({ dropped: 0 });
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it("stays inactive when activation times out", async () => {
    vi.useFakeTimers();
    const callTool = vi.fn((..._args: ToolCallArgs) => new Promise<unknown>(() => undefined));
    const telemetry = makeTelemetry(callTool);
    await vi.advanceTimersByTimeAsync(2_000);
    await settle();

    expect(telemetry.active).toBe(false);
    telemetry.record("ui.render", {});
    await telemetry.flush();
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it("does not activate on an error result", async () => {
    const callTool = vi.fn((..._args: ToolCallArgs) => Promise.resolve({ isError: true }));
    const telemetry = makeTelemetry(callTool);
    await settle();

    expect(telemetry.active).toBe(false);
    telemetry.record("ui.render", {});
    await telemetry.flush();
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it("remains inert without a bridge", async () => {
    const telemetry = createAppTelemetry({
      manifest: { spans: ["ui.render"] as const },
      now: () => 10,
    });

    telemetry.record("ui.render", {});
    await telemetry.flush();
    await telemetry.dispose();
    expect(telemetry.active).toBe(false);
    expect(telemetry.stats()).toEqual({ dropped: 0 });
  });

  it("bounds rate-limited queues, drops oldest spans, and respects batch limits", async () => {
    vi.useFakeTimers();
    let rejectFirst: ((result: unknown) => void) | undefined;
    const calls: { readonly spans: readonly AppSpan[] }[] = [];
    const callTool = vi.fn((...args: Parameters<AppTelemetryBridge["callTool"]>) => {
      const batch = args[1];
      if (batch.spans.length === 0) {
        return Promise.resolve({});
      }
      calls.push(batch);
      if (calls.length === 1) {
        return new Promise<unknown>((resolve) => {
          rejectFirst = () => {
            resolve({
              isError: true,
              content: [{ type: "text", text: "rate_limited" }],
            });
          };
        });
      }
      return Promise.resolve({});
    });
    const telemetry = makeTelemetry(callTool);
    await settle();

    for (let count = 0; count < 20; count += 1) {
      telemetry.record("ui.interaction", { kind: "click", count });
    }
    await settle();
    expect(calls).toHaveLength(1);

    for (let count = 20; count < 140; count += 1) {
      telemetry.record("ui.interaction", { kind: "click", count });
    }
    expect(telemetry.stats()).toEqual({ dropped: 20 });
    rejectFirst?.({});
    await settle();
    expect(telemetry.stats()).toEqual({ dropped: 40 });
    await vi.advanceTimersByTimeAsync(500);
    await vi.waitFor(() => {
      expect(calls).toHaveLength(3);
    });

    const delivered = calls
      .slice(1)
      .flatMap(({ spans }) =>
        spans.map((span) => (span.name === "ui.interaction" ? span.count : -1)),
      );
    expect(delivered).toEqual(Array.from({ length: 100 }, (_value, index) => index + 40));
    expect(calls.every(({ spans }) => spans.length <= 50)).toBe(true);
    expect(calls.every((batch) => JSON.stringify(batch).length <= 14 * 1024)).toBe(true);
    expect(JSON.stringify(callTool.mock.calls)).not.toContain("dropped");
    await telemetry.dispose();
  });

  it("backs off exponentially from 500 ms to the 8 s cap", async () => {
    vi.useFakeTimers();
    let sends = 0;
    const callTool = vi.fn((...args: Parameters<AppTelemetryBridge["callTool"]>) => {
      if (args[1].spans.length === 0) {
        return Promise.resolve({});
      }
      sends += 1;
      return Promise.resolve(
        sends < 7 ? { isError: true, content: [{ type: "text", text: "rate_limited" }] } : {},
      );
    });
    const telemetry = makeTelemetry(callTool);
    await settle();
    for (let count = 0; count < 20; count += 1) {
      telemetry.record("ui.render", {});
    }
    await settle();

    for (const delay of [500, 1_000, 2_000, 4_000, 8_000, 8_000]) {
      const previousSends = sends;
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(sends).toBe(previousSends);
      await vi.advanceTimersByTimeAsync(1);
      await settle();
      expect(sends).toBe(previousSends + 1);
    }
    expect(sends).toBe(7);
    await telemetry.dispose();
  });

  it("flushes on the interval, pagehide, and hidden visibility changes", async () => {
    vi.useFakeTimers();
    const windowTarget = new EventTarget();
    const documentTarget = new EventTarget();
    let visibilityState = "visible";
    vi.stubGlobal("window", windowTarget);
    vi.stubGlobal("document", {
      addEventListener: documentTarget.addEventListener.bind(documentTarget),
      removeEventListener: documentTarget.removeEventListener.bind(documentTarget),
      get visibilityState() {
        return visibilityState;
      },
    });
    const callTool = vi.fn((..._args: ToolCallArgs) => Promise.resolve({}));
    const telemetry = makeTelemetry(callTool);
    await settle();

    telemetry.record("ui.render", {});
    visibilityState = "hidden";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(dataCalls(callTool)).toHaveLength(1);

    telemetry.record("ui.render", {});
    visibilityState = "visible";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(dataCalls(callTool)).toHaveLength(1);
    windowTarget.dispatchEvent(new Event("pagehide"));
    await settle();
    expect(dataCalls(callTool)).toHaveLength(2);

    telemetry.record("ui.render", {});
    await vi.advanceTimersByTimeAsync(2_000);
    await settle();
    expect(dataCalls(callTool)).toHaveLength(3);
    await telemetry.dispose();
  });

  it("disposes listeners and timers after one final flush", async () => {
    vi.useFakeTimers();
    const callTool = vi.fn((..._args: ToolCallArgs) => Promise.resolve({}));
    const telemetry = makeTelemetry(callTool);
    await settle();
    telemetry.record("ui.render", {});
    await telemetry.dispose();
    expect(dataCalls(callTool)).toHaveLength(1);
    telemetry.record("ui.render", {});
    await vi.advanceTimersByTimeAsync(2_000);
    expect(dataCalls(callTool)).toHaveLength(1);
    await telemetry.flush();
    expect(telemetry.active).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears an outstanding backoff timer during disposal", async () => {
    vi.useFakeTimers();
    const callTool = vi.fn((...args: ToolCallArgs) =>
      Promise.resolve(
        args[1].spans.length === 0
          ? {}
          : { isError: true, content: [{ type: "text", text: "rate_limited" }] },
      ),
    );
    const telemetry = makeTelemetry(callTool);
    await settle();
    telemetry.record("ui.render", {});
    await telemetry.flush();
    await settle();
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    await telemetry.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains spans when JSON sizing fails or exceeds the per-call limit", async () => {
    const callTool = vi.fn((..._args: ToolCallArgs) => Promise.resolve({}));
    const telemetry = makeTelemetry(callTool);
    await waitForActive(telemetry);
    const stringify = vi.spyOn(JSON, "stringify").mockImplementation(() => {
      throw new Error("synthetic serialization failure");
    });
    for (let count = 0; count < 20; count += 1) {
      telemetry.record("ui.render", {});
    }

    await telemetry.flush();
    stringify.mockReturnValue("x".repeat(14 * 1024 + 1));
    await telemetry.flush();
    stringify.mockRestore();
    await telemetry.flush();
    expect(dataCalls(callTool)).toHaveLength(1);
    await telemetry.dispose();
  });

  it("keeps activation and transport property-access failures silent", async () => {
    const result = Object.defineProperty({}, "isError", {
      get() {
        throw new Error("synthetic getter failure");
      },
    });
    const activationFailure = makeTelemetry(
      vi.fn((..._args: ToolCallArgs) => Promise.resolve(result)),
    );
    await settle();
    expect(activationFailure.active).toBe(false);
    await activationFailure.dispose();

    const metadata = Object.defineProperty({}, "traceparent", {
      get() {
        throw new Error("synthetic metadata failure");
      },
    });
    const successful = makeTelemetry(
      vi.fn((..._args: ToolCallArgs) => Promise.resolve({ _meta: metadata })),
    );
    await waitForActive(successful);
    expect(successful.traceContext.traceId).toBeUndefined();
    await successful.dispose();
  });

  it("does not throw if browser lifecycle registration fails", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      addEventListener() {
        throw new Error("synthetic event registration failure");
      },
      removeEventListener: vi.fn(),
    });
    const telemetry = makeTelemetry(vi.fn((..._args: ToolCallArgs) => Promise.resolve({})));
    await settle();
    expect(telemetry.active).toBe(true);
    await telemetry.dispose();
  });

  it("retains generic bridge failures for a later flush", async () => {
    let fail = true;
    const callTool = vi.fn((...args: ToolCallArgs) => {
      if (args[1].spans.length === 0 || !fail) {
        return Promise.resolve({});
      }
      return Promise.reject(new Error("host unavailable"));
    });
    const telemetry = makeTelemetry(callTool);
    await waitForActive(telemetry);
    telemetry.record("ui.render", {});
    await telemetry.flush();
    fail = false;
    await telemetry.flush();
    expect(dataCalls(callTool)).toHaveLength(2);
    await telemetry.dispose();
  });
});
