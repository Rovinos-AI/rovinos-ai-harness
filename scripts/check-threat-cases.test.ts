// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { findMissingThreatIds, ThreatCasesSchema, type ThreatCase } from "./check-threat-cases.js";

const activeCase: ThreatCase = {
  id: "T-01",
  title: "Runner cannot control the host container runtime",
  mitigationTask: "19.3",
  testFile: "packages/sandbox/runner/src/server.int.test.ts",
  activeFromTask: "19.3",
};

describe("findMissingThreatIds", () => {
  it("reports an active threat without a referencing test", () => {
    expect(findMissingThreatIds([activeCase], new Set(["19.3"]), new Set())).toEqual(["T-01"]);
  });

  it("skips threats whose owning task is not complete", () => {
    expect(findMissingThreatIds([activeCase], new Set(), new Set())).toEqual([]);
  });
});

describe("ThreatCasesSchema", () => {
  it("rejects duplicate threat ids", () => {
    expect(ThreatCasesSchema.safeParse([activeCase, activeCase]).success).toBe(false);
  });
});
