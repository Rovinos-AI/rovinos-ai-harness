// SPDX-License-Identifier: Apache-2.0
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { assertNoCredentialCanaries } from "./mcp-conformance-report-safety.js";

it("detects a run-seeded credential canary in archived MCP reports", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-report-canary-"));
  const canary = `fixture-${randomBytes(32).toString("hex")}`;
  try {
    await writeFile(join(directory, "report.json"), JSON.stringify({ status: canary }));
    await expect(assertNoCredentialCanaries(directory, [canary])).rejects.toThrow(
      "mcp_conformance_report_exposed_credential",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
