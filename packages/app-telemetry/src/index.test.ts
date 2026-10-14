// SPDX-License-Identifier: Apache-2.0
import { describe, expect, expectTypeOf, it, vi } from "vitest";
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

describe("createAppTelemetry", () => {
  it("validates span names against the app manifest", () => {
    const declared = new Set<AppSpanName>(["ui.render"]);
    expect(isManifestSpanName("ui.render", declared)).toBe(true);
    expect(isManifestSpanName("ui.other", declared)).toBe(false);
    expect(isManifestSpanName(1, declared)).toBe(false);
  });

  it("binds attributes to each schema span name", () => {
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
  });

  it("records elapsed duration and shim-relative offset", async () => {
    const callTool = createCallTool();
    const times = [100, 120, 134, 150];
    const telemetry = createAppTelemetry({
      bridge: { callTool },
      manifest: { spans: ["ui.render", "ui.interaction"] as const },
      now: () => times.shift() ?? 150,
    });
    expect(telemetry.active).toBe(true);

    telemetry.start("ui.render").end();
    telemetry.record("ui.interaction", { kind: "click", count: 2 }, 7.2);
    await telemetry.flush();

    expect(callTool).toHaveBeenCalledWith("harness.telemetry.emit", {
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
  });

  it("silently ignores names not declared at runtime", async () => {
    const callTool = createCallTool();
    const spans: readonly AppSpanName[] = ["ui.render"];
    const telemetry = createAppTelemetry({
      bridge: { callTool },
      manifest: { spans },
      now: () => 10,
    });

    telemetry.start("ui.error").end({ code: "not_declared" });
    telemetry.record("ui.error", { code: "not_declared" });
    await expect(telemetry.flush()).resolves.toBeUndefined();

    expect(callTool).not.toHaveBeenCalled();
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
    let fail = true;
    const callTool = vi.fn((..._args: Parameters<AppTelemetryBridge["callTool"]>) => {
      if (fail) {
        return Promise.reject(new Error("host unavailable"));
      }
      return Promise.resolve({});
    });
    const telemetry = createAppTelemetry({
      bridge: { callTool },
      manifest: { spans: ["ui.render"] as const },
      now: () => 10,
    });

    telemetry.record("ui.render", {});
    await expect(telemetry.flush()).resolves.toBeUndefined();
    fail = false;
    await expect(telemetry.flush()).resolves.toBeUndefined();

    expect(callTool).toHaveBeenCalledTimes(2);
    expect(callTool).toHaveBeenLastCalledWith("harness.telemetry.emit", {
      spans: [{ name: "ui.render", startOffsetMs: 0, durationMs: 0 }],
    });
  });

  it("never sends undeclared attribute values", async () => {
    const canary = "synthetic-private-value";
    const callTool = createCallTool();
    const telemetry = createAppTelemetry({
      bridge: { callTool },
      manifest: { spans: ["ui.error"] as const },
      now: () => 1,
    });
    const attrs = { code: "ui.failure", privateData: canary };

    telemetry.record("ui.error", attrs);
    await telemetry.flush();

    expect(callTool).not.toHaveBeenCalled();
    expect(JSON.stringify(callTool.mock.calls)).not.toContain(canary);
  });

  it("rejects malformed attributes and limits a batch to the host schema", async () => {
    const callTool = createCallTool();
    const telemetry = createAppTelemetry({
      bridge: { callTool },
      manifest: { spans: ["ui.render", "ui.interaction"] as const },
      now: () => 1,
    });

    for (let count = 0; count < 51; count += 1) {
      telemetry.record("ui.interaction", { kind: "click", count: 1001 });
      telemetry.record("ui.render", {});
    }
    await telemetry.flush();

    expect(callTool).toHaveBeenCalledTimes(1);
    const sent = callTool.mock.calls[0]?.[1];
    expect(sent?.spans).toHaveLength(50);
    expect(sent?.spans.every((span) => span.name === "ui.render")).toBe(true);
  });
});
