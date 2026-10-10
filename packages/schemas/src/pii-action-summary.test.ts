// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { PiiActionSummarySchema } from "./pii-action-summary.js";

describe("PiiActionSummarySchema", () => {
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
