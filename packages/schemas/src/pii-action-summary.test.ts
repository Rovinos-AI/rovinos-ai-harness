// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { PiiActionSummarySchema, toPiiActionEventPayload } from "./pii-action-summary.js";
import { EventSchema } from "./events.js";

describe("PiiActionSummarySchema", () => {
  it.each([
    ["tokenize", "tokenized"],
    ["redact", "redacted"],
    ["block", "blocked"],
    ["allow", "allowed"],
  ] as const)("converts %s summaries to canonical %s events", (action, expected) => {
    const summary = PiiActionSummarySchema.parse({
      boundary: "model_input",
      action,
      entities: [{ type: "email", count: 1 }],
    });
    const event = EventSchema.parse({
      runId: "A".repeat(26),
      segmentId: "B".repeat(26),
      seq: 0,
      ts: 0,
      v: 1,
      traceId: "1".repeat(32),
      spanId: "2".repeat(16),
      type: "pii_action",
      ...toPiiActionEventPayload(summary),
    });
    expect(event).toMatchObject({ action: expected, entities: summary.entities });
    expect(summary.action).toBe(action);
  });

  it("accepts action summaries with positive entity counts", () => {
    expect(
      PiiActionSummarySchema.parse({
        boundary: "model_input",
        action: "tokenize",
        entities: [{ type: "email", count: 2 }],
      }),
    ).toEqual({
      boundary: "model_input",
      action: "tokenize",
      entities: [{ type: "email", count: 2 }],
    });
  });

  it("rejects extra content-bearing fields before event conversion", () => {
    const entity: { type: "email"; count: number; value: string } = {
      type: "email",
      count: 1,
      value: "alice@example.test",
    };
    const summary: {
      boundary: "model_input";
      action: "tokenize";
      entities: (typeof entity)[];
    } = {
      boundary: "model_input",
      action: "tokenize",
      entities: [entity],
    };

    expect(() => toPiiActionEventPayload(summary)).toThrow();
  });

  it.each([
    { boundary: "unknown", action: "tokenize", entities: [{ type: "email", count: 1 }] },
    { boundary: "model_input", action: "unknown", entities: [{ type: "email", count: 1 }] },
    { boundary: "model_input", action: "tokenize", entities: [] },
    { boundary: "model_input", action: "tokenize", entities: [{ type: "email", count: 0 }] },
    {
      boundary: "model_input",
      action: "tokenize",
      entities: [{ type: "email", count: 1, value: "alice@example.test" }],
    },
  ])("rejects invalid or content-bearing summaries", (summary) => {
    expect(PiiActionSummarySchema.safeParse(summary).success).toBe(false);
  });
});
