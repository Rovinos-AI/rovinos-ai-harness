// SPDX-License-Identifier: Apache-2.0
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StreamableHTTPClientTransport, type CallToolResult } from "@modelcontextprotocol/client";
import { trace } from "@opentelemetry/api";
import { ServerConfigSchema } from "@harness/schemas";
import { describe, expect, it, vi } from "vitest";
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
  it("sends HTTP trace metadata in the request body, not as propagation headers", async () => {
    interface CapturedRequest {
      readonly headers: Headers;
      readonly body: {
        readonly id?: string | number;
        readonly method?: string;
        readonly params?: Record<string, unknown>;
      };
    }
    const requests: CapturedRequest[] = [];
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      const body: CapturedRequest["body"] = JSON.parse(String(init?.body));
      requests.push({ headers: new Headers(init?.headers), body });
      const result =
        body.method === "initialize"
          ? {
              protocolVersion: "2025-11-25",
              capabilities: { tools: {} },
              serverInfo: { name: "http-test", version: "1.0.0" },
            }
          : body.method === "tools/call"
            ? { content: [{ type: "text", text: "called" }] }
            : undefined;
      return result === undefined
        ? new Response(null, { status: 202 })
        : Response.json({ jsonrpc: "2.0", id: body.id ?? 0, result });
    };
    const spanContext = {
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      traceFlags: 1,
    };
    const span = trace.getTracer("mcp-test").startSpan("mcp.call");
    const activeSpan = new Proxy(span, {
      get(target, property, receiver) {
        return property === "spanContext"
          ? () => spanContext
          : Reflect.get(target, property, receiver);
      },
    });
    const activeSpanSpy = vi.spyOn(trace, "getActiveSpan").mockReturnValue(activeSpan);
    vi.stubGlobal("fetch", fetch);
    const config = ServerConfigSchema.parse({
      id: "http_test",
      trust: "internal",
      propagateTrace: true,
      transport: { kind: "http", url: "https://mcp.example.test/rpc" },
      protocol: "2025-11-25",
      timeouts: { connectMs: 1_000, callMs: 1_000 },
    });
    const connection = new McpConnection(config, {
      resolveSecret: () => Promise.reject(new Error("unexpected secret reference")),
    });

    try {
      await connection.connect();
      await connection.callTool({ name: "tool-1", arguments: {} }, { type: "object" });

      const callRequest = requests.find(({ body }) => body.method === "tools/call");
      expect(callRequest?.body.params?._meta).toEqual({
        traceparent: `00-${spanContext.traceId}-${spanContext.spanId}-01`,
      });
      expect(
        requests.every(
          ({ headers }) =>
            !headers.has("traceparent") && !headers.has("tracestate") && !headers.has("baggage"),
        ),
      ).toBe(true);
    } finally {
      await connection.close();
      span.end();
      activeSpanSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it.each([
    { inheritEnv: false, expectedPath: null },
    { inheritEnv: true, expectedPath: "safe-parent-path" },
  ])(
    "limits child environment inheritance when inheritEnv=$inheritEnv",
    async ({ inheritEnv, expectedPath }) => {
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
          path: expectedPath,
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
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-env-"));
      const outputFile = path.join(directory, "keys.json");
      // macOS adds __CF_* keys to every process at exec; they are not inherited from the parent.
      const config = ServerConfigSchema.parse({
        id: "stdio_keys",
        transport: {
          kind: "stdio",
          command: process.execPath,
          args: [
            "-e",
            "require('node:fs').writeFileSync(process.argv[1], JSON.stringify(Object.keys(process.env).filter((key) => !key.startsWith('__CF_')).sort()))",
            outputFile,
          ],
          inheritEnv,
          env: { CONFIGURED: "configured-value" },
        },
      });

      const transport = await createMcpTransport(config, {
        env: {
          PATH: process.env.PATH ?? "/bin:/usr/bin",
          [canary]: "canary-secret",
        },
        resolveSecret: () => Promise.reject(new Error("no secret expected")),
      });

      try {
        await transport.start();
        await vi.waitFor(() => {
          expect(fs.existsSync(outputFile)).toBe(true);
        });
        await transport.close();

        const receivedKeys: unknown = JSON.parse(fs.readFileSync(outputFile, "utf8"));
        expect(receivedKeys).toEqual(expectedKeys);
        expect(receivedKeys).not.toContain(canary);
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
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
