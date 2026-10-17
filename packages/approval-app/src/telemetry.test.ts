// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppTelemetry } from "@harness/app-telemetry";
import {
  createApprovalTelemetry,
  type ApprovalTelemetryEnvironment,
} from "./telemetry.js";

type SpanNames = readonly ["ui.render", "ui.decision", "ui.error", "ui.interaction"];
type TestTelemetry = AppTelemetry<SpanNames>;
const originalRequestAnimationFrame = Object.getOwnPropertyDescriptor(
  window,
  "requestAnimationFrame",
);
const originalVisibilityState = Object.getOwnPropertyDescriptor(document, "visibilityState");

function setup() {
  const records: { readonly name: string; readonly attrs: Record<string, unknown> }[] = [];
  const renderEnds: ReturnType<typeof vi.fn>[] = [];
  const frames: FrameRequestCallback[] = [];
  let now = 0;
  const telemetry = {
    start: vi.fn(() => {
      const end = vi.fn();
      renderEnds.push(end);
      return { end };
    }),
    record: vi.fn((name: string, attrs: Record<string, unknown>) => {
      records.push({ name, attrs });
    }),
    flush: vi.fn(() => Promise.resolve()),
  } as unknown as TestTelemetry;
  const environment: ApprovalTelemetryEnvironment = {
    window,
    document,
    now: () => now,
  };
  Object.defineProperty(window, "requestAnimationFrame", {
    configurable: true,
    value: (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    },
  });
  const lifecycle = createApprovalTelemetry(telemetry, environment);
  return {
    telemetry,
    lifecycle,
    records,
    renderEnds,
    frames,
    setNow: (value: number) => {
      now = value;
    },
  };
}

afterEach(() => {
  document.body.replaceChildren();
  if (originalRequestAnimationFrame === undefined) {
    Reflect.deleteProperty(window, "requestAnimationFrame");
  } else {
    Object.defineProperty(window, "requestAnimationFrame", originalRequestAnimationFrame);
  }
  if (originalVisibilityState === undefined) {
    Reflect.deleteProperty(document, "visibilityState");
  } else {
    Object.defineProperty(document, "visibilityState", originalVisibilityState);
  }
});

describe("approval app telemetry", () => {
  it("records one render after two animation frames and measures decision time from first paint", () => {
    const { lifecycle, telemetry, renderEnds, frames, setNow } = setup();
    lifecycle.receivePayload(() => setNow(2));
    expect(telemetry.start).toHaveBeenCalledExactlyOnceWith("ui.render");
    expect(frames).toHaveLength(1);
    frames.shift()?.(0);
    setNow(12);
    expect(frames).toHaveLength(1);
    frames.shift()?.(0);
    expect(renderEnds[0]).toHaveBeenCalledOnce();
    setNow(19);
    expect(lifecycle.decisionDurationMs()).toBe(7);
  });

  it("handles overlapping payload renders and uses only the latest completed render", () => {
    const { lifecycle, telemetry, frames, renderEnds, setNow } = setup();
    lifecycle.receivePayload(() => undefined);
    lifecycle.receivePayload(() => undefined);
    setNow(5);
    frames.shift()?.(0);
    frames.shift()?.(0);
    setNow(10);
    frames.shift()?.(0);
    frames.shift()?.(0);
    expect(renderEnds).toHaveLength(2);
    expect(renderEnds.every((end) => end.mock.calls.length === 1)).toBe(true);
    setNow(18);
    expect(lifecycle.decisionDurationMs()).toBe(8);
    expect(telemetry.start).toHaveBeenCalledTimes(2);
  });

  it("deduplicates closed errors and never records window error or rejection messages", () => {
    const { lifecycle, records } = setup();
    lifecycle.reportError("payload_invalid");
    lifecycle.reportError("payload_invalid");
    const canary = "SYNTHETIC_ERROR_MESSAGE_CANARY";
    window.dispatchEvent(new ErrorEvent("error", { message: canary, error: new Error(canary) }));
    const rejection = new Event("unhandledrejection");
    Object.defineProperty(rejection, "reason", { value: new Error(canary) });
    window.dispatchEvent(rejection);
    document.dispatchEvent(new Event("securitypolicyviolation"));
    document.dispatchEvent(new Event("securitypolicyviolation"));
    lifecycle.reportError("bridge_unavailable");
    lifecycle.reportError("resolve_failed");
    lifecycle.reportError("reveal_failed");
    expect(records).toEqual([
      { name: "ui.error", attrs: { code: "payload_invalid" } },
      { name: "ui.error", attrs: { code: "render_failed" } },
      { name: "ui.error", attrs: { code: "csp_blocked" } },
      { name: "ui.error", attrs: { code: "bridge_unavailable" } },
      { name: "ui.error", attrs: { code: "resolve_failed" } },
      { name: "ui.error", attrs: { code: "reveal_failed" } },
    ]);
    expect(JSON.stringify(records)).not.toContain(canary);
  });

  it("aggregates interactions by kind and flushes one span of each kind when hidden", () => {
    const { lifecycle, telemetry, records } = setup();
    document.dispatchEvent(new Event("click"));
    document.dispatchEvent(new Event("click"));
    document.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("input"));
    document.dispatchEvent(new Event("input"));
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("pagehide"));
    expect(records).toEqual([
      { name: "ui.interaction", attrs: { kind: "click", count: 2 } },
      { name: "ui.interaction", attrs: { kind: "focus", count: 1 } },
      { name: "ui.interaction", attrs: { kind: "edit", count: 2 } },
    ]);
    expect(telemetry.flush).toHaveBeenCalledTimes(2);
  });

  it("bounds interaction counts and flushes pending counts on disposal only once", () => {
    const { lifecycle, records, telemetry } = setup();
    for (let count = 0; count < 1002; count += 1) {
      document.dispatchEvent(new Event("click"));
    }
    document.dispatchEvent(new Event("input"));
    lifecycle.dispose();
    lifecycle.dispose();
    document.dispatchEvent(new Event("click"));
    expect(records).toEqual([
      { name: "ui.interaction", attrs: { kind: "click", count: 1000 } },
      { name: "ui.interaction", attrs: { kind: "edit", count: 1 } },
    ]);
    expect(telemetry.flush).toHaveBeenCalledOnce();
    expect(lifecycle.decisionDurationMs()).toBe(0);
  });

  it("does not flush visible changes and ignores errors after disposal", () => {
    const { lifecycle, records, telemetry } = setup();
    document.dispatchEvent(new Event("click"));
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(records).toEqual([]);
    lifecycle.dispose();
    const callsAtDispose = records.length;
    window.dispatchEvent(new ErrorEvent("error", { message: "SYNTHETIC_CANARY" }));
    document.dispatchEvent(new Event("securitypolicyviolation"));
    expect(records).toHaveLength(callsAtDispose);
    expect(telemetry.flush).toHaveBeenCalledOnce();
  });
});
