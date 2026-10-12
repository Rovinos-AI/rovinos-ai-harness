// SPDX-License-Identifier: Apache-2.0
import {
  StreamableHTTPClientTransport,
  type CallToolResult,
} from "@modelcontextprotocol/client";
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
    { inheritEnv: false, path: "" },
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
          home: "",
          user: "",
          shell: "",
          term: "",
          parent: null,
          configured: "configured-value",
        }),
      });
      expect(events).toEqual([
        { code: "mcp_stderr", serverId: "stdio_test", bytes: Buffer.byteLength("private stderr marker") },
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
      resolveSecret: async (ref) => {
        references.push(ref);
        return "resolved-token";
      },
    });

    expect(transport).toBeInstanceOf(StreamableHTTPClientTransport);
    expect(references).toEqual(["env:MCP_HTTP_TOKEN"]);
    await transport.close();
  });
});
