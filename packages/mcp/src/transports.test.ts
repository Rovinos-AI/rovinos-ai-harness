// SPDX-License-Identifier: Apache-2.0
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  Client,
  StreamableHTTPClientTransport,
  type CallToolResult,
} from "@modelcontextprotocol/client";
import { context as otelContext, trace } from "@opentelemetry/api";
import { gzipSync } from "node:zlib";
import { ServerConfigSchema } from "@rovinos/schemas";
import { createTestContextManager, createTestTracerProvider } from "@rovinos/telemetry/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { McpConnection } from "./connection.js";
import { createMcpTransport, createResponseLimitedFetch, type McpLogEvent } from "./transports.js";

const tracerProvider = createTestTracerProvider();

beforeAll(() => {
  otelContext.setGlobalContextManager(createTestContextManager());
  trace.setGlobalTracerProvider(tracerProvider);
});

afterAll(() => {
  otelContext.disable();
  trace.disable();
});

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
  it("refuses HTTP redirects instead of following them to another destination", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new TypeError("redirect refused"));
    try {
      await expect(
        createResponseLimitedFetch(1_024)("https://mcp.example.test/mcp", {
          redirect: "follow",
        }),
      ).rejects.toThrow("redirect refused");
      expect(fetch).toHaveBeenCalledWith(
        new URL("https://mcp.example.test/mcp"),
        expect.objectContaining({ redirect: "manual" }),
      );
    } finally {
      fetch.mockRestore();
    }
  });

  it("follows bounded same-origin MCP endpoint redirects", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 308, headers: { location: "/mcp/" } }))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    try {
      const response = await createResponseLimitedFetch(1_024)("https://mcp.example.test/mcp", {
        method: "POST",
        body: "{}",
      });

      expect(await response.json()).toEqual({ ok: true });
      expect(fetch).toHaveBeenNthCalledWith(
        1,
        new URL("https://mcp.example.test/mcp"),
        expect.objectContaining({ redirect: "manual" }),
      );
      expect(fetch).toHaveBeenNthCalledWith(
        2,
        new URL("https://mcp.example.test/mcp/"),
        expect.objectContaining({ redirect: "manual" }),
      );
    } finally {
      fetch.mockRestore();
    }
  });

  it("refuses cross-origin MCP endpoint redirects", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(null, { status: 308, headers: { location: "https://other.example/mcp" } }),
      );
    try {
      await expect(
        createResponseLimitedFetch(1_024)("https://mcp.example.test/mcp", {
          method: "POST",
          body: "{}",
        }),
      ).rejects.toThrow("MCP redirect refused");
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      fetch.mockRestore();
    }
  });

  it("sends HTTP trace metadata only in _meta and strips configured reserved headers", async () => {
    interface CapturedRequest {
      readonly headers: Headers;
      readonly body: {
        readonly id?: string | number;
        readonly method?: string;
        readonly params?: Record<string, unknown>;
      };
    }
    function isRecord(value: unknown): value is Record<string, unknown> {
      return typeof value === "object" && value !== null && !Array.isArray(value);
    }
    const requests: CapturedRequest[] = [];
    const fetch: typeof globalThis.fetch = (_input, init) => {
      const requestText = typeof init?.body === "string" ? init.body : "";
      const parsedBody: unknown = JSON.parse(requestText);
      const request = isRecord(parsedBody) ? parsedBody : {};
      const body: CapturedRequest["body"] = {
        ...(typeof request.id === "string" || typeof request.id === "number"
          ? { id: request.id }
          : {}),
        ...(typeof request.method === "string" ? { method: request.method } : {}),
        ...(isRecord(request.params) ? { params: request.params } : {}),
      };
      requests.push({ headers: new Headers(init?.headers), body });
      if (body.method === "initialize") {
        return Promise.resolve(
          Response.json({
            jsonrpc: "2.0",
            id: body.id ?? 0,
            result: {
              protocolVersion: "2025-11-25",
              capabilities: { tools: {} },
              serverInfo: { name: "http-test", version: "1.0.0" },
            },
          }),
        );
      }
      if (body.method === "tools/call") {
        return Promise.resolve(
          Response.json({
            jsonrpc: "2.0",
            id: body.id ?? 0,
            result: { content: [{ type: "text", text: "called" }] },
          }),
        );
      }
      return Promise.resolve(new Response(null, { status: 202 }));
    };
    vi.stubGlobal("fetch", fetch);
    const trustedConfig = ServerConfigSchema.parse({
      id: "http_trusted",
      trust: "internal",
      propagateTrace: true,
      transport: { kind: "http", url: "https://mcp.example.test/rpc" },
      protocol: "2025-11-25",
      timeouts: { connectMs: 1_000, callMs: 1_000 },
    });

    const externalConfig = ServerConfigSchema.parse({
      id: "http_external",
      trust: "external",
      transport: { kind: "http", url: "https://mcp.example.test/rpc" },
      protocol: "2025-11-25",
      timeouts: { connectMs: 1_000, callMs: 1_000 },
    });
    for (const config of [trustedConfig, externalConfig]) {
      if (config.transport.kind !== "http") {
        throw new Error("Expected HTTP transport");
      }
      Object.assign(
        (config.transport.headers ??= {}),
        config.trust === "internal"
          ? {
              TrAcEpArEnT: "env:TRACEPARENT",
              TRACESTATE: "env:TRACESTATE",
              bAgGaGe: "env:BAGGAGE",
            }
          : {
              TRACEPARENT: "env:TRACEPARENT",
              TraceState: "env:TRACESTATE",
              Baggage: "env:BAGGAGE",
            },
      );
    }
    const resolveSecret = vi.fn(() => Promise.reject(new Error("reserved header was resolved")));
    const trustedConnection = new McpConnection(trustedConfig, {
      resolveSecret,
    });
    const externalConnection = new McpConnection(externalConfig, {
      resolveSecret,
    });

    try {
      await trace.getTracer("mcp-test").startActiveSpan("harness.mcp_call", async (span) => {
        await trustedConnection.callTool({
          params: {
            name: "tool-1",
            arguments: {},
            _meta: {
              progressToken: "trusted-progress",
              traceparent: "00-stale",
              tracestate: "stale=value",
              baggage: "private=value",
            },
          },
          inputSchema: { type: "object" },
        });
        await externalConnection.callTool({
          params: {
            name: "tool-1",
            arguments: {},
            _meta: {
              progressToken: "external-progress",
              traceparent: "00-stale",
              tracestate: "stale=value",
              baggage: "private=value",
            },
          },
          inputSchema: { type: "object" },
        });

        const callRequests = requests.filter(({ body }) => body.method === "tools/call");
        expect(callRequests.map(({ body }) => body.params?._meta)).toEqual([
          {
            progressToken: "trusted-progress",
            traceparent: `00-${span.spanContext().traceId}-${span.spanContext().spanId}-01`,
          },
          { progressToken: "external-progress" },
        ]);
      });
      expect(resolveSecret).not.toHaveBeenCalled();
      expect(
        requests.every(
          ({ headers }) =>
            !headers.has("traceparent") && !headers.has("tracestate") && !headers.has("baggage"),
        ),
      ).toBe(true);
    } finally {
      await trustedConnection.close();
      await externalConnection.close();
      vi.unstubAllGlobals();
    }
  });

  it("fails closed on an oversized streamed HTTP response before consuming the full body", async () => {
    let pulledChunks = 0;
    const chunkCount = 12;
    const fetch: typeof globalThis.fetch = (_input, init) => {
      const requestText = typeof init?.body === "string" ? init.body : "";
      const parsed: unknown = JSON.parse(requestText);
      if (typeof parsed !== "object" || parsed === null || !("method" in parsed)) {
        throw new Error("invalid synthetic request");
      }
      const requestId =
        "id" in parsed && (typeof parsed.id === "string" || typeof parsed.id === "number")
          ? parsed.id
          : undefined;
      const requestMethod =
        "method" in parsed && typeof parsed.method === "string" ? parsed.method : undefined;
      if (requestMethod === "initialize") {
        return Promise.resolve(
          Response.json({
            jsonrpc: "2.0",
            id: requestId ?? 0,
            result: {
              protocolVersion: "2025-11-25",
              capabilities: { resources: {} },
              serverInfo: { name: "http-test", version: "1.0.0" },
            },
          }),
        );
      }
      if (requestMethod !== "resources/read") {
        return Promise.resolve(new Response(null, { status: 202 }));
      }
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulledChunks++;
          if (pulledChunks <= chunkCount) {
            controller.enqueue(new Uint8Array(256));
          } else {
            controller.close();
          }
        },
      });
      return Promise.resolve(
        new Response(body, {
          headers: { "content-type": "application/json" },
        }),
      );
    };
    vi.stubGlobal("fetch", fetch);
    const config = ServerConfigSchema.parse({
      id: "http_limited",
      transport: { kind: "http", url: "https://mcp.example.test/rpc" },
      protocol: "2025-11-25",
      maxResultBytes: 512,
    });
    const transport = await createMcpTransport(config, {
      resolveSecret: () => Promise.reject(new Error("no secret expected")),
    });
    const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });

    try {
      await client.connect(transport);
      await expect(client.readResource({ uri: "test://resource" })).rejects.toMatchObject({
        code: "mcp_response_too_large",
      });
      expect(pulledChunks).toBeLessThan(chunkCount);
    } finally {
      await client.close().catch(() => undefined);
      vi.unstubAllGlobals();
    }
  });

  it("limits the decompressed bytes from a small gzip HTTP response", async () => {
    const expandedBody = Buffer.from("x".repeat(1_048_576));
    const compressedBody = gzipSync(expandedBody);
    let decodedBytes = 0;
    const fetch: typeof globalThis.fetch = (_input, init) => {
      const requestText = typeof init?.body === "string" ? init.body : "";
      const parsed: unknown = JSON.parse(requestText);
      if (typeof parsed !== "object" || parsed === null || !("method" in parsed)) {
        throw new Error("invalid synthetic request");
      }
      const requestId =
        "id" in parsed && (typeof parsed.id === "string" || typeof parsed.id === "number")
          ? parsed.id
          : undefined;
      const requestMethod =
        "method" in parsed && typeof parsed.method === "string" ? parsed.method : undefined;
      if (requestMethod === "initialize") {
        return Promise.resolve(
          Response.json({
            jsonrpc: "2.0",
            id: requestId ?? 0,
            result: {
              protocolVersion: "2025-11-25",
              capabilities: { resources: {} },
              serverInfo: { name: "http-test", version: "1.0.0" },
            },
          }),
        );
      }
      if (requestMethod !== "resources/read") {
        return Promise.resolve(new Response(null, { status: 202 }));
      }
      const expandedStream = new Blob([compressedBody])
        .stream()
        .pipeThrough(new DecompressionStream("gzip"))
        .pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              decodedBytes += chunk.byteLength;
              controller.enqueue(chunk);
            },
          }),
        );
      return Promise.resolve(
        new Response(expandedStream, {
          headers: {
            "content-encoding": "gzip",
            "content-length": String(compressedBody.byteLength),
            "content-type": "application/json",
          },
        }),
      );
    };
    vi.stubGlobal("fetch", fetch);
    const config = ServerConfigSchema.parse({
      id: "http_gzip_limited",
      transport: { kind: "http", url: "https://mcp.example.test/rpc" },
      protocol: "2025-11-25",
      maxResultBytes: 2_048,
    });
    const transport = await createMcpTransport(config, {
      resolveSecret: () => Promise.reject(new Error("no secret expected")),
    });
    const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });

    try {
      expect(compressedBody.byteLength).toBeLessThan(config.maxResultBytes);
      await client.connect(transport);
      await expect(client.readResource({ uri: "test://gzip-resource" })).rejects.toMatchObject({
        code: "mcp_response_too_large",
      });
      expect(decodedBytes).toBeLessThan(expandedBody.byteLength);
    } finally {
      await client.close().catch(() => undefined);
      vi.unstubAllGlobals();
    }
  });

  it("caps stdio frames before the SDK parses an oversized line", async () => {
    const script = [
      "import { createInterface } from 'node:readline';",
      "const input = createInterface({ input: process.stdin });",
      "input.on('line', (line) => {",
      "  const request = JSON.parse(line);",
      "  if (request.method === 'initialize') {",
      "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'stdio', version: '1' } } }) + '\\n');",
      "  } else if (request.method === 'tools/list') {",
      "    process.stdout.write('x'.repeat(4096));",
      "  }",
      "});",
    ].join("\n");
    const config = ServerConfigSchema.parse({
      id: "stdio_oversized",
      transport: {
        kind: "stdio",
        command: process.execPath,
        args: ["--input-type=module", "-e", script],
      },
      protocol: "2025-11-25",
      maxResultBytes: 512,
      timeouts: { connectMs: 2_000, callMs: 2_000 },
    });
    const connection = new McpConnection(config, {
      resolveSecret: () => Promise.reject(new Error("no secret expected")),
    });

    try {
      await connection.connect();
      await expect(connection.listTools()).rejects.toMatchObject({
        code: "mcp_list_tools_failed",
      });
    } finally {
      await connection.close();
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
      const result: CallToolResult = await connection.callTool({
        params: { name: "environment", arguments: {} },
        inputSchema: { type: "object" },
      });

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
