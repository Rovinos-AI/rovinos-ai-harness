// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { requiredConformanceExitCode } from "./mcp-conformance.ts";

describe("required conformance results", () => {
  it("passes only when every measured required scenario passes", () => {
    expect(requiredConformanceExitCode(["passed", "passed"])).toBe(0);
    expect(requiredConformanceExitCode(["passed", "failed"])).toBe(1);
    expect(requiredConformanceExitCode(["skipped"])).toBe(1);
    expect(requiredConformanceExitCode(["not_measured"])).toBe(1);
  });
});
