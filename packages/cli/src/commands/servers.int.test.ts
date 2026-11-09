// SPDX-License-Identifier: Apache-2.0
import { InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { HarnessConfigSchema } from "@rovinos/config";
import { parseJson, ServersCheckResultSchema } from "@rovinos/schemas";
import { describe, expect, it } from "vitest";
import type { CliContext } from "../command.js";
import { ExitCode } from "../exit-codes.js";
import { main } from "../main.js";
import { createOutput } from "../output.js";
import { createServersCommand } from "./servers.js";

const descriptionCanary = "servers-check-integration-description-canary";
const errorCanary = "servers-check-integration-error-canary";

async function runCheck(transportKind: "stdio" | "http", failDiscovery = false) {
  const [client, serverTransport] = InMemoryTransport.createLinkedPair();
  const peer = new McpServer({ name: "servers-check-integration", version: "1.0.0" });
  let toolCalls = 0;
  peer.server.registerCapabilities({
    tools: {},
    extensions: { "io.modelcontextprotocol/ui": {} },
  });
  peer.server.setRequestHandler("tools/list", () => {
    if (failDiscovery) {
      throw new Error(errorCanary);
    }
    return {
      tools: [
        {
          name: "safe",
          description: descriptionCanary,
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
      ],
    };
  });
  peer.server.setRequestHandler("tools/call", () => {
    toolCalls += 1;
    return { content: [{ type: "text", text: errorCanary }] };
  });
  await peer.connect(serverTransport);

  let stdout = "";
  let stderr = "";
  const context: CliContext = {
    loadConfig: () =>
      Promise.resolve(
        HarnessConfigSchema.parse({
          servers: [
            {
              id: "primary",
              transport:
                transportKind === "stdio"
                  ? { kind: "stdio", command: "unused" }
                  : { kind: "http", url: "https://mcp.example.test/mcp" },
            },
          ],
        }),
      ),
    out: createOutput({
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    }),
    clock: { now: () => 1 },
  };

  try {
    const exitCode = await main(["--json", "servers", "check"], context, [
      createServersCommand({ createTransport: () => Promise.resolve(client) }),
    ]);
    return {
      exitCode,
      output: `${stdout}${stderr}`,
      result: parseJson(ServersCheckResultSchema, stdout.trim()),
      toolCalls,
    };
  } finally {
    await Promise.all([client.close(), serverTransport.close()]);
  }
}

describe("harness servers check integration", () => {
  it.each(["stdio", "http"] as const)(
    "reports complete, safe results for %s servers without invoking tools",
    async (transportKind) => {
      const { exitCode, output, result, toolCalls } = await runCheck(transportKind);

      expect(exitCode).toBe(ExitCode.ok);
      expect(result.reportVersion).toBe(1);
      expect(result.catalogFingerprintStatus).toBe("complete");
      expect(result.servers).toContainEqual(
        expect.objectContaining({
          transportKind,
          capabilities: { apps: "yes", tools: "yes" },
          phases: {
            connection: { status: "success" },
            authentication: { status: "not_applicable" },
            negotiation: { status: "success" },
            discovery: { status: "success" },
            schemaValidation: { status: "success" },
            exposure: { status: "success" },
            policyConfiguration: { status: "not_tested", allowlistConfigured: false },
          },
        }),
      );
      expect(toolCalls).toBe(0);
      expect(output).not.toContain(descriptionCanary);
      expect(output).not.toContain(errorCanary);
    },
  );

  it.each(["stdio", "http"] as const)(
    "marks discovery as failed and omits the catalog fingerprint for %s servers",
    async (transportKind) => {
      const { exitCode, output, result, toolCalls } = await runCheck(transportKind, true);

      expect(exitCode).toBe(ExitCode.failure);
      expect(result.catalogFingerprintStatus).toBe("not_tested");
      expect(result.catalogFingerprint).toBeUndefined();
      expect(result.servers).toContainEqual(
        expect.objectContaining({
          reachable: false,
          phases: {
            connection: { status: "success" },
            authentication: { status: "not_applicable" },
            negotiation: { status: "success" },
            discovery: { status: "failed", errorCode: "mcp_list_tools_failed" },
            schemaValidation: { status: "not_tested" },
            exposure: { status: "not_tested" },
            policyConfiguration: { status: "not_tested", allowlistConfigured: false },
          },
          nextAction: "retry_discovery",
        }),
      );
      expect(toolCalls).toBe(0);
      expect(output).not.toContain(descriptionCanary);
      expect(output).not.toContain(errorCanary);
    },
  );

  it("emits deterministic JSON for the same discovered catalog", async () => {
    const first = await runCheck("stdio");
    const second = await runCheck("stdio");

    expect(first.result).toEqual(second.result);
  });
});
