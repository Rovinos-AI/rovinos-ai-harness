// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { AppSpanSchema } from "./app-span.js";

describe("AppSpanSchema", () => {
  it.each([
    { name: "ui.render", startOffsetMs: 0, durationMs: 0 },
    { name: "ui.decision", decision: "approve", startOffsetMs: 1, durationMs: 10 },
    { name: "ui.input", action: "accept", startOffsetMs: 2, durationMs: 4 },
    { name: "ui.error", code: "payload_invalid", startOffsetMs: 2, durationMs: 20 },
    {
      name: "ui.interaction",
      kind: "click",
      count: 1,
      startOffsetMs: 3,
      durationMs: 30,
    },
  ])("accepts the closed $name span", (span) => {
    expect(AppSpanSchema.parse(span)).toEqual(span);
  });

  it.each([
    { name: "ui.render", startOffsetMs: -1, durationMs: 0 },
    { name: "ui.decision", decision: "unknown", startOffsetMs: 0, durationMs: 0 },
    { name: "ui.input", action: "navigate", startOffsetMs: 0, durationMs: 0 },
    { name: "ui.error", code: "INVALID_CODE", startOffsetMs: 0, durationMs: 0 },
    {
      name: "ui.interaction",
      kind: "click",
      count: 1001,
      startOffsetMs: 0,
      durationMs: 0,
    },
    { name: "ui.render", startOffsetMs: 0, durationMs: 0, extra: true },
  ])("rejects invalid span %#", (span) => {
    expect(AppSpanSchema.safeParse(span).success).toBe(false);
  });
});
