// SPDX-License-Identifier: Apache-2.0
import { diag, type SpanContext, type TraceState } from "@opentelemetry/api";
import { ServerConfigSchema } from "@harness/schemas";
import { describe, expect, it, vi } from "vitest";
import { buildRequestMeta } from "./trace-injection.js";

function serverConfig(trust: "internal" | "external", propagateTrace: boolean) {
  return ServerConfigSchema.parse({
    id: "mcp_test",
    transport: { kind: "stdio", command: "not-spawned-by-test" },
    trust,
    propagateTrace,
  });
}

function spanContext(traceStateValue?: string, traceFlags = 1): SpanContext {
  const traceState: TraceState = {
    get: () => undefined,
    set: () => traceState,
    unset: () => traceState,
    serialize: () => traceStateValue ?? "",
  };
  return {
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
    traceFlags,
    ...(traceStateValue === undefined ? {} : { traceState }),
  };
}

describe("buildRequestMeta", () => {
  it("propagates the active span only to an opted-in internal server", () => {
    expect(
      buildRequestMeta({
        server: serverConfig("internal", true),
        spanContext: spanContext("vendor=value", 0x101),
        existingMeta: {
          progressToken: "progress-1",
          traceparent: "00-stale",
          tracestate: "stale=value",
          baggage: "private=value",
        },
      }),
    ).toEqual({
      progressToken: "progress-1",
      traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01`,
      tracestate: "vendor=value",
    });
  });

  it.each([
    { trust: "external" as const, propagateTrace: false },
    { trust: "internal" as const, propagateTrace: false },
  ])(
    "strips caller trace metadata when propagation is not allowed",
    ({ trust, propagateTrace }) => {
      expect(
        buildRequestMeta({
          server: serverConfig(trust, propagateTrace),
          spanContext: spanContext("vendor=value"),
          existingMeta: {
            progressToken: "progress-1",
            traceparent: "00-stale",
            tracestate: "stale=value",
            baggage: "private=value",
          },
        }),
      ).toEqual({ progressToken: "progress-1" });
    },
  );

  it("omits invalid span context while preserving unrelated request metadata", () => {
    expect(
      buildRequestMeta({
        server: serverConfig("internal", true),
        spanContext: { traceId: "invalid", spanId: "b".repeat(16), traceFlags: 1 },
        existingMeta: { progressToken: "progress-1", baggage: "private=value" },
      }),
    ).toEqual({ progressToken: "progress-1" });
  });

  it("returns undefined when no request metadata or valid trace context remains", () => {
    expect(
      buildRequestMeta({
        server: serverConfig("external", false),
        spanContext: undefined,
        existingMeta: { baggage: "private=value", traceparent: "00-stale" },
      }),
    ).toBeUndefined();
  });

  it.each([
    { traceState: "v".repeat(512), expected: "v".repeat(512) },
    { traceState: "v".repeat(513), expected: undefined },
  ])("omits tracestate longer than 512 characters", ({ traceState: value, expected }) => {
    const debug = vi.spyOn(diag, "debug").mockImplementation(() => undefined);
    const result = buildRequestMeta({
      server: serverConfig("internal", true),
      spanContext: spanContext(value),
    });

    expect(result?.tracestate).toBe(expected);
    expect(debug).toHaveBeenCalledTimes(expected === undefined ? 1 : 0);
    debug.mockRestore();
  });
});
