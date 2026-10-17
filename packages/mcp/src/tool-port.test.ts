// SPDX-License-Identifier: Apache-2.0
import {
  InMemoryTransport,
  StreamableHTTPClientTransport,
  ProtocolError,
  type CallToolRequest,
  type CallToolResult,
  type Tool,
  type Transport,
} from "@modelcontextprotocol/client";
import { context as otelContext, SpanStatusCode, trace } from "@opentelemetry/api";
import type { SpanContext } from "@opentelemetry/api";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { JsonValue, ServerConfigSchema } from "@harness/schemas";
import { createTestContextManager, createTestSpanCollector } from "@harness/telemetry/testing";
import { lookupSpanDefinition } from "@harness/telemetry";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { McpConnection } from "./connection.js";
import { McpAuthRequiredError } from "./oauth/provider.js";
import { McpToolPort } from "./tool-port.js";

const spanCollector = createTestSpanCollector();
const canary = "TOOL_ERROR_CANARY";
const inputSchema = {
  type: "object",
  properties: { value: { type: "string" } },
  required: ["value"],
  additionalProperties: false,
} satisfies Tool["inputSchema"];

interface Peer {
  readonly client: InMemoryTransport;
  readonly serverTransport: InMemoryTransport;
}

interface Fixture {
  readonly peer: Peer;
  readonly port: McpToolPort;
  readonly calls: CallToolRequest["params"][];
  readonly receivedMeta: (Record<string, unknown> | undefined)[];
  close(): Promise<void>;
}

async function fixture(
  options: {
    readonly result?: CallToolResult;
    readonly protocolError?: number;
    readonly neverResolve?: boolean;
    readonly callMs?: number;
    readonly maxResultBytes?: number;
    readonly offloadBinaryResults?: boolean;
    readonly authRequiredMethod?: "tools/list" | "tools/call";
  } = {},
): Promise<Fixture> {
  const [client, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = new McpServer({ name: "tool-port-test", version: "1.0.0" });
  const calls: CallToolRequest["params"][] = [];
  const receivedMeta: (Record<string, unknown> | undefined)[] = [];
  server.server.registerCapabilities({ tools: { listChanged: true } });
  server.server.setRequestHandler("tools/list", () => ({
    tools: [{ name: "echo", inputSchema }],
  }));
  server.server.setRequestHandler("tools/call", (request) => {
    calls.push(request.params);
    receivedMeta.push(request.params._meta);
    if (options.protocolError !== undefined) {
      throw new ProtocolError(options.protocolError, canary);
    }
    if (options.neverResolve === true) {
      return new Promise<CallToolResult>(() => undefined);
    }
    return (
      options.result ?? {
        content: [{ type: "text", text: "success" }],
      }
    );
  });
  await server.connect(serverTransport);
  const peer = { client, serverTransport };
  const config = ServerConfigSchema.parse({
    id: "mcp_test",
    transport: { kind: "stdio", command: "not-spawned-by-test" },
    protocol: "2025-11-25",
    timeouts: { callMs: options.callMs ?? 1_000 },
    maxResultBytes: options.maxResultBytes ?? 1_048_576,
  });
  const transport: Transport =
    options.authRequiredMethod === undefined
      ? client
      : new Proxy(client, {
          get(target, property) {
            if (property === "send") {
              return (
                message: Parameters<InMemoryTransport["send"]>[0],
                sendOptions?: Parameters<InMemoryTransport["send"]>[1],
              ) => {
                if ("method" in message && message.method === options.authRequiredMethod) {
                  throw new McpAuthRequiredError();
                }
                return target.send(message, sendOptions);
              };
            }
            const value: unknown = Reflect.get(target, property, target);
            return value;
          },
        });
  let port: McpToolPort;
  try {
    port = await McpToolPort.create(
      [config],
      {
        resolveSecret: () => Promise.reject(new Error("unexpected secret")),
        createTransport: () => transport,
      },
      {
        ...(options.offloadBinaryResults === undefined
          ? {}
          : { offloadBinaryResults: options.offloadBinaryResults }),
      },
    );
  } catch (error) {
    await serverTransport.close();
    throw error;
  }
  return {
    peer,
    port,
    calls,
    receivedMeta,
    close: async () => {
      await port.close();
      await serverTransport.close();
    },
  };
}

function context(signal = new AbortController().signal) {
  return { signal };
}

const call = {
  callId: "00000000000000000000000000",
  toolId: "mcp_test.echo",
  args: { value: "ok" },
};

beforeAll(() => {
  otelContext.setGlobalContextManager(createTestContextManager());
  trace.setGlobalTracerProvider(spanCollector.provider);
});

afterAll(() => {
  otelContext.disable();
  trace.disable();
});

describe("McpToolPort", () => {
  it("preserves authorization errors during initial tools/list discovery", async () => {
    await expect(fixture({ authRequiredMethod: "tools/list" })).rejects.toMatchObject({
      code: "mcp_auth_required",
    });
  });

  it("preserves authorization errors returned during public tool execution", async () => {
    const current = await fixture({ authRequiredMethod: "tools/call" });
    try {
      await expect(current.port.execute(call, context())).resolves.toEqual({
        outcome: "error",
        errorCode: "mcp_auth_required",
        result: null,
      });
      const attributes = spanCollector.getFinishedSpans().at(-1)?.attributes ?? {};
      expect(attributes["harness.error.code"]).toBe("mcp_auth_required");
      expect(JSON.stringify(attributes)).not.toContain(canary);
    } finally {
      await current.close();
    }
  });

  it("executes registered tools and emits only registered call-span attributes", async () => {
    const current = await fixture();
    try {
      const result = await current.port.execute(call, context());
      expect(result).toEqual({
        outcome: "ok",
        result: { content: [{ type: "text", text: "success" }] },
      });
      expect(current.calls).toHaveLength(1);
      expect(current.port.describe("mcp_test.echo")).toMatchObject({
        idempotent: false,
        timeoutMs: 1_000,
        longRunning: true,
      });
      const span = spanCollector.getFinishedSpans().at(-1);
      expect(span?.name).toBe("mcp.client.call");
      expect(span?.attributes).toMatchObject({
        "mcp.method.name": "tools/call",
        "harness.mcp.server_id": "mcp_test",
        "harness.tool.id": "mcp_test.echo",
        "harness.outcome": "ok",
      });
      expect(Object.keys(span?.attributes ?? {}).sort()).toEqual([
        "harness.mcp.server_id",
        "harness.outcome",
        "harness.tool.id",
        "mcp.method.name",
      ]);
      expect(lookupSpanDefinition("mcp.client.call")?.shape).toHaveProperty("mcp.method.name");
    } finally {
      await current.close();
    }
  });

  it("preserves isError result content while keeping error text out of telemetry", async () => {
    const current = await fixture({
      result: { isError: true, content: [{ type: "text", text: canary }] },
    });
    try {
      const result = await current.port.execute(call, context());
      expect(result).toEqual({
        outcome: "error",
        errorCode: "tool_reported_error",
        result: { content: [{ type: "text", text: canary }] },
      });
      expect(JSON.stringify(spanCollector.getFinishedSpans().at(-1)?.attributes)).not.toContain(
        canary,
      );
      expect(spanCollector.getFinishedSpans().at(-1)?.attributes["harness.outcome"]).toBe("error");
      expect(spanCollector.getFinishedSpans().at(-1)?.attributes["harness.error.code"]).toBe(
        "tool_reported_error",
      );
      expect(spanCollector.getFinishedSpans().at(-1)?.status.code).toBe(SpanStatusCode.ERROR);
    } finally {
      await current.close();
    }
  });

  it.each([
    [-32602, "mcp_invalid_params"],
    [-32601, "mcp_method_not_found"],
    [-32603, "mcp_internal_error"],
    [-32020, "mcp_header_mismatch"],
    [-32021, "mcp_capability_missing"],
    [-32022, "mcp_protocol_unsupported"],
    [-32000, "mcp_error"],
  ])("maps JSON-RPC code %i without retaining server text", async (protocolError, errorCode) => {
    const current = await fixture({ protocolError });
    try {
      const result = await current.port.execute(call, context());
      expect(result).toEqual({ outcome: "error", errorCode, result: null });
      expect(JSON.stringify(result)).not.toContain(canary);
      const span = spanCollector.getFinishedSpans().at(-1);
      expect(span?.attributes["harness.error.code"]).toBe(errorCode);
      expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    } finally {
      await current.close();
    }
  });

  it("maps call timeouts to mcp_timeout", async () => {
    const current = await fixture({ neverResolve: true, callMs: 20 });
    try {
      await expect(current.port.execute(call, context())).resolves.toMatchObject({
        outcome: "error",
        errorCode: "mcp_timeout",
        result: null,
      });
    } finally {
      await current.close();
    }
  });

  it("does not send calls when the caller has already aborted", async () => {
    const current = await fixture();
    const controller = new AbortController();
    controller.abort();
    try {
      await expect(current.port.execute(call, context(controller.signal))).resolves.toMatchObject({
        outcome: "error",
        errorCode: "mcp_timeout",
      });
      expect(current.calls).toHaveLength(0);
    } finally {
      await current.close();
    }
  });

  it("rejects oversized serialized results", async () => {
    const current = await fixture({
      result: { content: [{ type: "text", text: "x".repeat(200) }] },
      maxResultBytes: 100,
    });
    try {
      await expect(current.port.execute(call, context())).resolves.toEqual({
        outcome: "error",
        errorCode: "result_too_large",
        result: null,
      });
    } finally {
      await current.close();
    }
  });

  it("keeps small binary blocks reduced to metadata and bounded data", async () => {
    const current = await fixture({
      result: {
        content: [
          { type: "image", mimeType: "image/png", data: Buffer.from([1, 2]).toString("base64") },
        ],
      },
    });
    try {
      await expect(current.port.execute(call, context())).resolves.toEqual({
        outcome: "ok",
        result: {
          content: [{ type: "image", mimeType: "image/png", bytes: 2, data: "AQI=" }],
        },
      });
    } finally {
      await current.close();
    }
  });

  it("returns a valid binary payload only when an offloader is configured", async () => {
    const bytes = Buffer.alloc(9_000, 1);
    const current = await fixture({
      offloadBinaryResults: true,
      result: {
        content: [{ type: "audio", mimeType: "audio/wav", data: bytes.toString("base64") }],
      },
    });
    try {
      const result = await current.port.execute(call, context());
      expect(result.outcome).toBe("ok");
      expect(result.binary).toBe(true);
      expect(result.result).toEqual(Array.from(bytes));
      expect(JsonValue.safeParse(result.result).success).toBe(true);
    } finally {
      await current.close();
    }
  });

  it("fails closed for a large binary result without an offloader", async () => {
    const current = await fixture({
      result: {
        content: [
          { type: "image", mimeType: "image/png", data: Buffer.alloc(9_000, 1).toString("base64") },
        ],
      },
    });
    try {
      await expect(current.port.execute(call, context())).resolves.toEqual({
        outcome: "error",
        errorCode: "binary_result_unavailable",
        result: null,
      });
    } finally {
      await current.close();
    }
  });

  it("validates arguments before any network call", async () => {
    const current = await fixture();
    try {
      const result = await current.port.execute({ ...call, args: {} }, context());
      expect(result).toEqual({ outcome: "error", errorCode: "args_invalid", result: null });
      expect(current.calls).toHaveLength(0);
    } finally {
      await current.close();
    }
  });

  it("treats missing resultType as complete", async () => {
    const complete = await fixture();
    try {
      await expect(complete.port.execute(call, context())).resolves.toMatchObject({
        outcome: "ok",
        result: { content: [{ type: "text", text: "success" }] },
      });
    } finally {
      await complete.close();
    }
  });

  it("fails with a typed error for unsupported input-required results", async () => {
    const current = await fixture();
    const callTool = vi.spyOn(McpConnection.prototype, "callTool").mockResolvedValue({
      content: [],
      resultType: "input_required",
    });
    try {
      await expect(current.port.execute(call, context())).resolves.toEqual({
        outcome: "error",
        errorCode: "mcp_input_required_unsupported",
        result: null,
      });
    } finally {
      callTool.mockRestore();
      await current.close();
    }
  });

  it("logs discovery failures by server id and fails startup instead of dropping the server", async () => {
    const log = vi.fn();
    await expect(
      McpToolPort.create(
        [
          ServerConfigSchema.parse({
            id: "mcp_test",
            transport: { kind: "stdio", command: "not-spawned-by-test" },
            protocol: "2025-11-25",
          }),
        ],
        {
          resolveSecret: () => Promise.reject(new Error("unexpected secret")),
          logger: { log },
          createTransport: () => Promise.reject(new Error("untrusted transport error")),
          sleep: () => Promise.resolve(),
        },
      ),
    ).rejects.toMatchObject({ code: "mcp_list_tools_failed" });
    expect(log).toHaveBeenCalledWith({
      code: "mcp_discovery_failed",
      serverId: "mcp_test",
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain("untrusted transport error");
  });

  it("keeps large text resources on the normal JSON result path", async () => {
    const text = "synthetic resource ".repeat(600);
    const current = await fixture({
      result: {
        content: [
          {
            type: "resource",
            resource: { uri: "file:///synthetic", mimeType: "text/plain", text },
          },
        ],
      },
    });
    try {
      const result = await current.port.execute(call, context());
      expect(result.binary).toBeUndefined();
      expect(result).toMatchObject({
        outcome: "ok",
        result: {
          content: [{ type: "resource", mimeType: "text/plain", data: text }],
        },
      });
    } finally {
      await current.close();
    }
  });

  it("propagates the MCP call span as the parent of trusted server spans", async () => {
    let receivedTraceparent: string | undefined;
    const schema = {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    } satisfies Tool["inputSchema"];
    const handler = createMcpHandler(
      () => {
        const server = new McpServer(
          { name: "trace-server", version: "1.0.0" },
          { supportedProtocolVersions: ["2026-07-28"] },
        );
        server.server.registerCapabilities({ tools: { listChanged: true } });
        server.server.setRequestHandler("tools/list", () => ({
          tools: [{ name: "echo", inputSchema: schema }],
        }));
        server.server.setRequestHandler("tools/call", (request) => {
          const meta = request.params._meta;
          receivedTraceparent =
            typeof meta?.traceparent === "string" ? meta.traceparent : undefined;
          const match = /^00-([a-f0-9]{32})-([a-f0-9]{16})-([a-f0-9]{2})$/u.exec(
            receivedTraceparent ?? "",
          );
          if (match?.[1] !== undefined && match[2] !== undefined && match[3] !== undefined) {
            const parent: SpanContext = {
              traceId: match[1],
              spanId: match[2],
              traceFlags: Number.parseInt(match[3], 16),
              isRemote: true,
            };
            otelContext.with(trace.setSpanContext(otelContext.active(), parent), () => {
              trace.getTracer("mcp-server-test").startSpan("server.tool").end();
            });
          }
          return { content: [{ type: "text", text: "called" }] };
        });
        return server;
      },
      { legacy: "reject" },
    );
    const clientTransport = new StreamableHTTPClientTransport(new URL("https://localhost/mcp"), {
      fetch: async (input, init) => handler.fetch(new Request(input, init)),
    });
    const port = await McpToolPort.create(
      [
        ServerConfigSchema.parse({
          id: "mcp_test",
          transport: { kind: "http", url: "https://localhost/mcp" },
          protocol: "2026-07-28",
          trust: "internal",
          propagateTrace: true,
        }),
      ],
      {
        resolveSecret: () => Promise.reject(new Error("unexpected secret")),
        createTransport: () => Promise.resolve(clientTransport),
      },
    );
    try {
      const before = spanCollector.getFinishedSpans().length;
      await expect(port.execute(call, context())).resolves.toMatchObject({ outcome: "ok" });
      const executionSpans = spanCollector.getFinishedSpans().slice(before);
      const callSpan = executionSpans.find(({ name }) => name === "mcp.client.call");
      const serverSpan = executionSpans.find(({ name }) => name === "server.tool");
      expect(receivedTraceparent).toBeDefined();
      expect(receivedTraceparent?.split("-")[2]).toBe(callSpan?.spanContext().spanId);
      expect(serverSpan?.parentSpanContext?.spanId).toBe(callSpan?.spanContext().spanId);
    } finally {
      await port.close();
      await handler.close();
    }
  });

  it("preserves structured results and normalizes embedded text resources", async () => {
    const current = await fixture({
      result: {
        content: [
          {
            type: "resource",
            resource: {
              uri: "file:///synthetic",
              mimeType: "text/plain",
              text: "resource text",
            },
          },
        ],
        structuredContent: { status: "ok" },
      },
    });
    try {
      await expect(current.port.execute(call, context())).resolves.toEqual({
        outcome: "ok",
        result: {
          content: [{ type: "resource", mimeType: "text/plain", bytes: 13, data: "resource text" }],
          structured: { status: "ok" },
        },
      });
    } finally {
      await current.close();
    }
  });

  it("reduces malformed and absent resource data to safe metadata", async () => {
    const current = await fixture({
      result: {
        content: [
          {
            type: "resource",
            resource: {
              uri: "file:///synthetic",
              mimeType: "application/octet-stream",
              blob: "AQI=",
            },
          },
        ],
      },
    });
    try {
      await expect(current.port.execute(call, context())).resolves.toMatchObject({
        outcome: "ok",
        result: {
          content: [
            { type: "resource", mimeType: "application/octet-stream", bytes: 2, data: "AQI=" },
          ],
        },
      });
    } finally {
      await current.close();
    }
  });
});
