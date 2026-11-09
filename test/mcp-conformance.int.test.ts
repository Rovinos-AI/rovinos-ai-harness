// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { INSPECTOR_HTTP_TOKEN, INSPECTOR_READ_TOKEN } from "../scripts/ci/inspector-http.js";
import { runConformanceScenario, runMcpConformanceLanes } from "../scripts/ci/mcp-conformance.js";

async function reportFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    files.push(...(entry.isDirectory() ? await reportFiles(path) : [path]));
  }
  return files;
}

it("executes both MCP roles and archives only synthetic, credential-free conformance reports", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "harness-mcp-conformance-test-"));
  try {
    const { report } = await runMcpConformanceLanes(join(workDir, "reports"));
    expect(report.protocolRevision).toBe("2026-07-28");
    expect(report.runner).toBe("@modelcontextprotocol/conformance@0.2.0-alpha.12");
    const clientStatus = report.client.find(({ scenario }) => scenario === "tools_call")?.status;
    expect(["passed", "failed"]).toContain(clientStatus);
    for (const scenario of ["server-stateless", "tools-list"]) {
      const status = report.server.find((entry) => entry.scenario === scenario)?.status;
      expect(["passed", "failed"]).toContain(status);
    }
    expect(report.client.some(({ status }) => status === "not_measured")).toBe(true);
    expect(report.server.some(({ status }) => status === "not_measured")).toBe(true);
    expect(report.notScored.length).toBeGreaterThan(0);
    expect(report.notMeasuredCapabilities).toHaveLength(2);
    const files = await reportFiles(join(workDir, "reports"));
    expect(files.some((path) => path.endsWith("checks.json"))).toBe(true);
    for (const path of files) {
      const content = await readFile(path, "utf8");
      expect(content).not.toContain(INSPECTOR_HTTP_TOKEN);
      expect(content).not.toContain(INSPECTOR_READ_TOKEN);
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}, 180_000);

it("fails a required client scenario when the fixture never calls its advertised tool", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "harness-mcp-conformance-negative-"));
  try {
    const status = await runConformanceScenario({
      role: "client",
      scenario: "tools_call",
      outputDir: join(workDir, "reports"),
      endpoint: "http://127.0.0.1:1/mcp",
      home: workDir,
      command: "node --input-type=module -e 'process.exit(0)'",
    });
    expect(status).toBe("failed");
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}, 90_000);
