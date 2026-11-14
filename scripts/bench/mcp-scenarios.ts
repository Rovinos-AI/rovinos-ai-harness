// SPDX-License-Identifier: Apache-2.0
import { InMemoryWorkspace, OffloadingToolPort } from "@rovinos/context";
import { normalizedResult } from "@rovinos/mcp/tool-result";
import { Code, JsonValue } from "@rovinos/schemas";
import { McpCatalogInspectionSchema, registerMcpServer, selectMcpTools } from "@rovinos/sdk";
import { hash, makeId, measure, metric, type BenchmarkProfile } from "./common.ts";
import type { BenchmarkResult } from "./contracts.ts";

function mcpCatalog(size: number) {
  const serverId = "bench_server";
  const tools = Array.from({ length: size }, (_, index) => ({
    name: `tool_${String(index)}`,
    toolId: `bench.tool_${String(index)}`,
    description: "Synthetic benchmark tool.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    exposed: false,
  }));
  const inspection = McpCatalogInspectionSchema.parse({
    serverId,
    catalogVersion: hash,
    tools,
    rejectedTools: [],
  });
  const config = registerMcpServer(
    {},
    {
      id: serverId,
      transport: { kind: "stdio", command: "node", args: ["synthetic-server.js"] },
    },
  );
  return { inspection, config };
}

async function catalogBenchmarks(profile: BenchmarkProfile, size: number) {
  const { config, inspection } = mcpCatalog(size);
  const selection = await measure(
    "sdk.mcp_catalog",
    () =>
      selectMcpTools(
        config,
        inspection,
        inspection.tools.slice(0, Math.min(32, size)).map(({ name }) => name),
      ),
    profile,
  );
  const rejected = {
    serverId: "bench_server",
    catalogVersion: hash,
    tools: Array.from({ length: size }, () => ({
      name: "",
      toolId: "",
      description: "",
      inputSchema: [],
      exposed: false,
    })),
    rejectedTools: [],
  };
  const rejectionStorm = await measure(
    "sdk.mcp_rejection_storm",
    () => McpCatalogInspectionSchema.safeParse(rejected),
    profile,
  );
  return { selection, rejectionStorm };
}

async function mixedResultOffloadBenchmark(profile: BenchmarkProfile, transferBytes: number) {
  const payload = Buffer.alloc(transferBytes, 7);
  const encoded = payload.toString("base64");
  const mixedResult = {
    isError: false,
    content: [
      { type: "text", text: "synthetic result" },
      { type: "image", mimeType: "application/octet-stream", data: encoded },
    ],
  } satisfies Parameters<typeof normalizedResult>[0];
  let offloadId = 40_000;
  const workspace = new InMemoryWorkspace();
  const offloader = new OffloadingToolPort(
    {
      describe: () => ({ idempotent: true, timeoutMs: 1000 }),
      execute: () => {
        const normalized = normalizedResult(mixedResult, {
          binaryResults: "allow",
          maxArtifactBytes: transferBytes,
        });
        return Promise.resolve({
          outcome: "ok",
          result: JsonValue.parse(normalized.value),
          artifacts: normalized.artifacts,
        });
      },
    },
    workspace,
    {},
    { ids: { next: () => makeId(offloadId++) } },
  );
  const offload = await measure(
    "mcp.mixed_result_offload",
    () =>
      offloader.execute(
        {
          callId: makeId(800),
          toolId: Code.parse("bench.mixed_result"),
          args: {},
        },
        { runId: makeId(801), signal: new AbortController().signal },
      ),
    profile,
  );
  return metric(
    "mcp.mixed_result_offload",
    (transferBytes / 1_048_576) * offload.operationsPerSecond,
    "MiB/s",
    offload.sampleCount,
  );
}

/** Measures MCP catalog selection, rejection storms, and binary result offloading. */
export async function mcpBenchmarks(
  profile: BenchmarkProfile,
): Promise<BenchmarkResult["metrics"]> {
  const size = profile.name === "nightly" ? 1_000 : 10;
  const { selection, rejectionStorm } = await catalogBenchmarks(profile, size);
  const transferBytes = profile.name === "nightly" ? 1_048_576 : 1024;
  const offload = await mixedResultOffloadBenchmark(profile, transferBytes);
  return [
    metric("sdk.mcp_catalog.1000_tools", selection.p95Ms, "ms", selection.sampleCount),
    metric("sdk.mcp.rejection_storm.1000", rejectionStorm.p95Ms, "ms", rejectionStorm.sampleCount),
    offload,
  ];
}
