// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { JsonValue } from "./json.js";
import {
  APP_TELEMETRY_TOOL_NAME,
  Code,
  Id,
  Pseudonym,
  Sha256Hex,
  SpanId,
  TraceId,
  Traceparent,
  WorkspaceRef,
} from "./primitives.js";

describe("primitive schemas", () => {
  it("exports the shared app telemetry tool name", () => {
    expect(APP_TELEMETRY_TOOL_NAME).toBe(["harness", "telemetry", "emit"].join("."));
  });

  it.each([
    [Id, "00000000000000000000000000", "0000000000000000000000000I"],
    [Code, "policy.v1", "UPPERCASE"],
    [Pseudonym, `p_${"a".repeat(26)}`, `p_${"a".repeat(25)}0`],
    [Sha256Hex, "a".repeat(64), "a".repeat(63)],
    [TraceId, "a".repeat(32), "g".repeat(32)],
    [SpanId, "b".repeat(16), "b".repeat(15)],
    [
      Traceparent,
      `00-${"a".repeat(32)}-${"b".repeat(16)}-01`,
      `01-${"a".repeat(32)}-${"b".repeat(16)}-01`,
    ],
    [WorkspaceRef, "workspace:/refs/head", "contains spaces"],
  ])("validates expected values", (schema, valid, invalid) => {
    expect(schema.safeParse(valid).success).toBe(true);
    expect(schema.safeParse(invalid).success).toBe(false);
  });

  it("accepts recursive JSON values and rejects non-JSON data", () => {
    expect(
      JsonValue.safeParse({
        array: [null, true, 1, "text", { nested: "value" }],
      }).success,
    ).toBe(true);
    expect(JsonValue.safeParse({ value: undefined }).success).toBe(false);
    expect(JsonValue.safeParse(Number.NaN).success).toBe(false);
  });
});
