// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";
import { openReport, registerOpenReportTool } from "./open-report.js";

const temporaryDirectories: string[] = [];
const reportSchemas = {
  eval: z.looseObject({ schemaVersion: z.literal(1) }),
  compare: z.looseObject({ schemaVersion: z.literal(1) }),
  replay: z.looseObject({ schemaVersion: z.literal(1) }),
};

async function setupDirectories(): Promise<{ readonly allowed: string; readonly outside: string }> {
  const root = await mkdtemp(join(tmpdir(), "harness-report-"));
  temporaryDirectories.push(root);
  const allowed = join(root, "reports");
  const outside = join(root, "outside");
  await mkdir(allowed);
  await mkdir(outside);
  return { allowed, outside };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("openReport", () => {
  it("parses each supported report with its report schema", async () => {
    const { allowed } = await setupDirectories();
    const reports = [
      ["eval", { schemaVersion: 1, invariantsEnabled: true, trials: [], aggregates: [] }],
      ["compare", { schemaVersion: 1, comparisons: [] }],
      [
        "replay",
        {
          schemaVersion: 1,
          originalRunId: "00000000000000000000000001",
          replayRunId: "00000000000000000000000002",
          status: "completed",
          configDrift: false,
          policyDrift: false,
          approximate: false,
          summary: { added: 0, behavioral: 0, changed: 0, noise: 0, removed: 0 },
          entries: [],
        },
      ],
    ] as const;
    for (const [kind, report] of reports) {
      const path = `${kind}.json`;
      await writeFile(join(allowed, path), JSON.stringify(report));
      await expect(openReport([allowed], reportSchemas, { kind, path })).resolves.toEqual({
        kind,
        report,
      });
    }
  });

  it("serves the parsed report through the read-only MCP tool without exposing its path", async () => {
    const { allowed } = await setupDirectories();
    const report = { schemaVersion: 1, invariantsEnabled: true, trials: [], aggregates: [] };
    await writeFile(join(allowed, "eval.json"), JSON.stringify(report));
    const server = new McpServer({ name: "open-report-test", version: "1.0.0" });
    registerOpenReportTool(server, [allowed], reportSchemas);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "open-report-client", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({
        name: "open_report",
        arguments: { kind: "eval", path: "eval.json" },
      });
      expect(result.structuredContent).toEqual({ kind: "eval", report });
      expect(result.content).toContainEqual({ type: "text", text: "eval report opened." });
      expect(JSON.stringify(result)).not.toContain(allowed);
    } finally {
      await client.close();
      await server.close();
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("rejects traversal outside a configured directory", async () => {
    const { allowed, outside } = await setupDirectories();
    await writeFile(join(outside, "report.json"), JSON.stringify({ schemaVersion: 1 }));
    await expect(
      openReport([allowed], reportSchemas, { kind: "eval", path: "../outside/report.json" }),
    ).rejects.toMatchObject({ code: "report_path_not_allowed" });
  });

  it("rejects absolute paths and symlinks that resolve outside configured directories", async () => {
    const { allowed, outside } = await setupDirectories();
    const outsidePath = join(outside, "report.json");
    await writeFile(outsidePath, JSON.stringify({ schemaVersion: 1 }));
    await symlink(outsidePath, join(allowed, "linked.json"));
    await expect(
      openReport([allowed], reportSchemas, { kind: "eval", path: outsidePath }),
    ).rejects.toMatchObject({ code: "report_path_not_allowed" });
    await expect(
      openReport([allowed], reportSchemas, { kind: "eval", path: "linked.json" }),
    ).rejects.toMatchObject({ code: "report_path_not_allowed" });
  });

  it("rejects invalid JSON contracts without returning file contents", async () => {
    const { allowed } = await setupDirectories();
    await writeFile(join(allowed, "invalid.json"), '{"private":"synthetic"}');
    await expect(
      openReport([allowed], reportSchemas, { kind: "eval", path: "invalid.json" }),
    ).rejects.toMatchObject({ code: "contract_invalid", message: "Contract validation failed." });
  });
});
