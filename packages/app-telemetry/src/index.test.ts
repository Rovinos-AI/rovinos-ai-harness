// SPDX-License-Identifier: Apache-2.0
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { APP_TELEMETRY_TOOL_NAME } from "@rovinos/schemas/browser";
import { createAppTelemetry } from "./index.js";
import {
  isManifestSpanName,
  type AppTelemetryBridge,
  type AppSpanName,
  type SpanAttrs,
} from "./types.js";

function createCallTool() {
  return vi.fn((..._args: Parameters<AppTelemetryBridge["callTool"]>) => Promise.resolve({}));
}

async function waitForActive(telemetry: { readonly active: boolean }): Promise<void> {
  await vi.waitFor(() => {
    expect(telemetry.active).toBe(true);
  });
}

describe("createAppTelemetry", () => {
  it("validates span names against the app manifest", () => {
    const declared = new Set<AppSpanName>(["ui.render"]);
    expect(isManifestSpanName("ui.render", declared)).toBe(true);
    expect(isManifestSpanName("ui.other", declared)).toBe(false);
    expect(isManifestSpanName(1, declared)).toBe(false);
  });

  it("binds attributes to each schema span name", async () => {
    type DecisionAttrs = SpanAttrs<"ui.decision">;
    type ErrorAttrs = SpanAttrs<"ui.error">;
    type RenderAttrs = SpanAttrs<"ui.render">;
    expectTypeOf<DecisionAttrs>().toEqualTypeOf<{
      decision: "approve" | "deny" | "edit";
    }>();
    expectTypeOf<ErrorAttrs>().toEqualTypeOf<{ code: string }>();
    expectTypeOf<RenderAttrs>().toEqualTypeOf<Record<string, never>>();

    const telemetry = createAppTelemetry({
      bridge: { callTool: () => Promise.resolve({}) },
      manifest: {
        spans: ["ui.render", "ui.decision", "ui.error", "ui.interaction"] as const,
      },
    });
    await waitForActive(telemetry);
    expect(telemetry.active).toBe(true);
    telemetry.record("ui.render", {});
    telemetry.record("ui.decision", { decision: "approve" });
    telemetry.record("ui.error", { code: "payload_invalid" });
    telemetry.record("ui.interaction", { kind: "click", count: 1 });
    telemetry.start("ui.decision").end({ decision: "deny" });

    // @ts-expect-error A decision span requires a decision attribute.
    telemetry.record("ui.decision", {});
    // @ts-expect-error An error span requires a code attribute.
    telemetry.record("ui.error", {});
    // @ts-expect-error A render span has no custom attributes.
    telemetry.record("ui.render", { code: "extra" });
    // @ts-expect-error Span names must be declared in the manifest.
    telemetry.start("ui.other");
    await telemetry.dispose();
  });

  it("records elapsed duration and shim-relative offset", async () => {
    const callTool = createCallTool();
    const times = [100, 120, 134, 150];
    const telemetry = createAppTelemetry({
      bridge: { callTool },
      manifest: { spans: ["ui.render", "ui.interaction"] as const },
      now: () => times.shift() ?? 150,
    });
    await waitForActive(telemetry);

    telemetry.start("ui.render").end();
    telemetry.record("ui.interaction", { kind: "click", count: 2 }, 7.2);
    await telemetry.flush();

    expect(callTool).toHaveBeenNthCalledWith(1, APP_TELEMETRY_TOOL_NAME, { spans: [] });
    expect(callTool).toHaveBeenNthCalledWith(2, APP_TELEMETRY_TOOL_NAME, {
      spans: [
        { name: "ui.render", startOffsetMs: 20, durationMs: 14 },
        {
          name: "ui.interaction",
          kind: "click",
          count: 2,
          startOffsetMs: 50,
          durationMs: 7,
        },
      ],
    });
    await telemetry.dispose();
  });

  it("waits for active sends and flushes spans queued during the send", async () => {
    let releaseFirst: (() => void) | undefined;
    let releaseSecond: (() => void) | undefined;
    const firstSend = new Promise<unknown>((resolve) => {
      releaseFirst = () => {
        resolve({});
      };
    });
    const secondSend = new Promise<unknown>((resolve) => {
      releaseSecond = () => {
        resolve({});
      };
    });
    let calls = 0;
    const callTool = vi.fn((..._args: Parameters<AppTelemetryBridge["callTool"]>) => {
      if (_args[1].spans.length === 0) {
        return Promise.resolve({});
      }
      calls += 1;
      return calls === 1 ? firstSend : secondSend;
    });
    const telemetry = createAppTelemetry({
      bridge: { callTool },
      manifest: { spans: ["ui.render", "ui.error"] as const },
      now: () => 10,
    });
    await waitForActive(telemetry);

    telemetry.record("ui.render", {});
    const firstFlush = telemetry.flush();
    await vi.waitFor(() => {
      expect(callTool).toHaveBeenCalledTimes(2);
    });
    telemetry.record("ui.error", { code: "during_send" });
    const secondFlush = telemetry.flush();
    let firstResolved = false;
    let secondResolved = false;
    const firstCompletion = firstFlush.then(() => {
      firstResolved = true;
    });
    const secondCompletion = secondFlush.then(() => {
      secondResolved = true;
    });

    expect(callTool).toHaveBeenNthCalledWith(2, APP_TELEMETRY_TOOL_NAME, {
      spans: [{ name: "ui.render", startOffsetMs: 0, durationMs: 0 }],
    });
    expect(firstResolved).toBe(false);
    expect(secondResolved).toBe(false);

    releaseFirst?.();
    await firstCompletion;
    await vi.waitFor(() => {
      expect(callTool).toHaveBeenCalledTimes(3);
    });
    expect(callTool).toHaveBeenNthCalledWith(3, APP_TELEMETRY_TOOL_NAME, {
      spans: [{ name: "ui.error", code: "during_send", startOffsetMs: 0, durationMs: 0 }],
    });
    expect(secondResolved).toBe(false);

    releaseSecond?.();
    await secondCompletion;
    expect(firstResolved).toBe(true);
    expect(secondResolved).toBe(true);
    await telemetry.dispose();
  });

  it("silently ignores names not declared at runtime", async () => {
    const callTool = createCallTool();
    const spans: readonly AppSpanName[] = ["ui.render"];
    const telemetry = createAppTelemetry({
      bridge: { callTool },
      manifest: { spans },
      now: () => 10,
    });
    await waitForActive(telemetry);

    telemetry.start("ui.error").end({ code: "not_declared" });
    telemetry.record("ui.error", { code: "not_declared" });
    await expect(telemetry.flush()).resolves.toBeUndefined();

    expect(callTool).toHaveBeenCalledTimes(1);
    expect(callTool).toHaveBeenCalledWith(APP_TELEMETRY_TOOL_NAME, { spans: [] });
    await telemetry.dispose();
  });

  it("is inactive and a no-op without a host bridge", async () => {
    const telemetry = createAppTelemetry({
      manifest: { spans: ["ui.render"] as const },
      now: () => 10,
    });

    expect(telemetry.active).toBe(false);
    telemetry.start("ui.render").end();
    telemetry.record("ui.render", {});
    await expect(telemetry.flush()).resolves.toBeUndefined();
  });

  it("swallows bridge errors and keeps the batch available for retry", async () => {
    vi.useFakeTimers();
    let fail = true;
    const callTool = vi.fn((..._args: Parameters<AppTelemetryBridge["callTool"]>) => {
      if (_args[1].spans.length === 0) {
        return Promise.resolve({});
      }
      if (fail) {
        return Promise.reject(new Error("host unavailable"));
      }
      return Promise.resolve({});
    });
    const telemetry = createAppTelemetry({
      bridge: { callTool },
      manifest: { spans: ["ui.render"] as const },
      now: () => 10,
      random: () => 0.5,
    });
    await waitForActive(telemetry);

    telemetry.record("ui.render", {});
    await expect(telemetry.flush()).resolves.toBeUndefined();
    fail = false;
    await expect(telemetry.flush()).resolves.toBeUndefined();
    expect(callTool).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(500);
    await vi.waitFor(() => {
      expect(callTool).toHaveBeenCalledTimes(3);
    });

    expect(callTool).toHaveBeenCalledTimes(3);
    expect(callTool).toHaveBeenLastCalledWith(APP_TELEMETRY_TOOL_NAME, {
      spans: [{ name: "ui.render", startOffsetMs: 0, durationMs: 0 }],
    });
    await telemetry.dispose();
    vi.useRealTimers();
  });

  it("never sends undeclared attribute values", async () => {
    const canary = "synthetic-private-value";
    const callTool = createCallTool();
    const telemetry = createAppTelemetry({
      bridge: { callTool },
      manifest: { spans: ["ui.error"] as const },
      now: () => 1,
    });
    await waitForActive(telemetry);
    const attrs = { code: "ui.failure", privateData: canary };

    telemetry.record("ui.error", attrs);
    await telemetry.flush();

    expect(callTool).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(callTool.mock.calls)).not.toContain(canary);
    await telemetry.dispose();
  });

  it("rejects malformed attributes and limits a batch to the host schema", async () => {
    const callTool = createCallTool();
    const telemetry = createAppTelemetry({
      bridge: { callTool },
      manifest: { spans: ["ui.render", "ui.interaction"] as const },
      now: () => 1,
    });
    await waitForActive(telemetry);

    for (let count = 0; count < 51; count += 1) {
      telemetry.record("ui.interaction", { kind: "click", count: 1001 });
      telemetry.record("ui.render", {});
    }
    await telemetry.flush();

    const dataCalls = callTool.mock.calls.slice(1);
    const sentSpans = dataCalls.flatMap((call) => call[1].spans);
    expect(sentSpans).toHaveLength(51);
    expect(dataCalls.every((call) => call[1].spans.length <= 50)).toBe(true);
    expect(sentSpans.every((span) => span.name === "ui.render")).toBe(true);
    await telemetry.dispose();
  });
});
