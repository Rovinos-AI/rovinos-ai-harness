// SPDX-License-Identifier: Apache-2.0
import {
  StreamableHTTPClientTransport,
  type CallToolResult,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { ServerConfigSchema } from "@harness/schemas";
import { describe, expect, it } from "vitest";
import { McpConnection } from "./connection.js";
import { createMcpTransport, type McpLogEvent } from "./transports.js";

const stdioServerScript = [
  "import { createInterface } from 'node:readline';",
  "const lines = createInterface({ input: process.stdin });",
  "process.stderr.write('private stderr marker');",
  "for await (const line of lines) {",
  "  const request = JSON.parse(line);",
  "  if (request.method === 'initialize') {",
  "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'stdio', version: '1' } } }) + '\\n');",
  "  } else if (request.method === 'tools/list') {",
  "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { tools: [{ name: 'environment', inputSchema: { type: 'object' } }] } }) + '\\n');",
  "  } else if (request.method === 'tools/call') {",
  "    const result = { path: process.env.PATH ?? null, home: process.env.HOME ?? null, user: process.env.USER ?? null, shell: process.env.SHELL ?? null, term: process.env.TERM ?? null, parent: process.env.PARENT_ONLY ?? null, configured: process.env.CONFIGURED ?? null };",
  "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } }) + '\\n');",
  "  }",
  "}",
].join("\n");

function stdioConfig(inheritEnv: boolean) {
  return ServerConfigSchema.parse({
    id: "stdio_test",
    transport: {
      kind: "stdio",
      command: process.execPath,
      args: ["--input-type=module", "-e", stdioServerScript],
      inheritEnv,
      env: { CONFIGURED: "configured-value" },
    },
    protocol: "2025-11-25",
    timeouts: { connectMs: 2_000, callMs: 2_000 },
  });
}

describe("MCP transports", () => {
  it.each([
    { inheritEnv: false, path: null },
    { inheritEnv: true, path: "safe-parent-path" },
  ])(
    "limits child environment inheritance when inheritEnv=$inheritEnv",
    async ({ inheritEnv, path }) => {
      const events: McpLogEvent[] = [];
      const connection = new McpConnection(stdioConfig(inheritEnv), {
        env: {
          PATH: "safe-parent-path",
          HOME: "private-home",
          USER: "private-user",
          PARENT_ONLY: "private-parent-value",
        },
        resolveSecret: () => Promise.reject(new Error("no secret expected")),
        logger: { log: (event) => events.push(event) },
      });

      await connection.connect();
      await connection.listTools();
      const result: CallToolResult = await connection.callTool(
        { name: "environment", arguments: {} },
        { type: "object" },
      );

      expect(result.content[0]).toMatchObject({
        text: JSON.stringify({
          path,
          home: null,
          user: null,
          shell: null,
          term: null,
          parent: null,
          configured: "configured-value",
        }),
      });
      expect(events).toEqual([
        {
          code: "mcp_stderr",
          serverId: "stdio_test",
          bytes: Buffer.byteLength("private stderr marker"),
        },
      ]);
      expect(JSON.stringify(events)).not.toContain("private stderr marker");
      expect(JSON.stringify(events)).not.toContain("private-parent-value");
      await connection.close();
    },
  );

  it("resolves HTTP header references before creating the SDK transport", async () => {
    const config = ServerConfigSchema.parse({
      id: "http_test",
      transport: {
        kind: "http",
        url: "https://mcp.example.test/rpc",
        headers: { Authorization: "env:MCP_HTTP_TOKEN" },
      },
    });
    const references: string[] = [];
    const transport = await createMcpTransport(config, {
      resolveSecret: (ref) => {
        references.push(ref);
        return Promise.resolve("resolved-token");
      },
    });

    expect(transport).toBeInstanceOf(StreamableHTTPClientTransport);
    expect(references).toEqual(["env:MCP_HTTP_TOKEN"]);
    await transport.close();
  });

  it.each([
    { inheritEnv: false, expectedKeys: ["CONFIGURED"] },
    { inheritEnv: true, expectedKeys: ["CONFIGURED", "PATH"] },
  ])(
    "spawns child process with exact environment key set (inheritEnv=$inheritEnv)",
    async ({ inheritEnv, expectedKeys }) => {
      const canary = "HARNESS_PARENT_CANARY";
      const config = ServerConfigSchema.parse({
        id: "stdio_keys",
        transport: {
          kind: "stdio",
          command: process.execPath,
          args: [
            "--input-type=module",
            "-e",
            "process.stdout.write(JSON.stringify(Object.keys(process.env).sort()))",
          ],
          inheritEnv,
          env: { CONFIGURED: "configured-value" },
        },
      });

      const transport = (await createMcpTransport(config, {
        env: {
          PATH: process.env.PATH ?? "/bin:/usr/bin",
          [canary]: "canary-secret",
        },
        resolveSecret: () => Promise.reject(new Error("no secret expected")),
      })) as StdioClientTransport;

      let output = "";
      await transport.start();
      const childProcess = (
        transport as unknown as { _process: import("node:child_process").ChildProcess }
      )._process;
      childProcess.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      await new Promise<void>((resolve) => childProcess.on("close", () => resolve()));
      await transport.close();

      const receivedKeys = JSON.parse(output) as string[];
      expect(receivedKeys).toEqual(expectedKeys);
      expect(receivedKeys).not.toContain(canary);
    },
  );

  it("fails when bare command is used without inheritEnv", async () => {
    const config = ServerConfigSchema.parse({
      id: "stdio_bare",
      transport: {
        kind: "stdio",
        command: "node",
        args: ["-v"],
        inheritEnv: false,
      },
    });

    const transport = await createMcpTransport(config, {
      resolveSecret: () => Promise.reject(new Error("no secret expected")),
    });

    await expect(transport.start()).rejects.toThrow();
    await transport.close().catch(() => undefined);
  });
});
