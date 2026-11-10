// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { advisoryConformanceOutcome } from "./mcp-conformance.ts";
import {
  conformanceReportSchema,
  protocolRevision,
  runnerRevision,
} from "./mcp-conformance-schema.ts";

describe("advisory conformance outcomes", () => {
  it("warns for failed scenarios but does not fail CI", () => {
    const report = conformanceReportSchema.parse({
      runner: `@modelcontextprotocol/conformance@${runnerRevision}`,
      protocolRevision,
      advisory: true,
      client: [{ scenario: "tools_call", status: "passed" }],
      server: [
        { scenario: "server-stateless", status: "failed" },
        { scenario: "tools-list", status: "passed" },
      ],
      notScored: [],
      notMeasuredCapabilities: [],
    });

    expect(advisoryConformanceOutcome(report)).toEqual({
      exitCode: 0,
      warnings: ["::warning::MCP conformance server scenario server-stateless failed"],
    });
  });

  it("fails when a harness error prevents a valid report", () => {
    expect(advisoryConformanceOutcome(undefined)).toEqual({
      exitCode: 1,
      warnings: [],
    });
  });
});
