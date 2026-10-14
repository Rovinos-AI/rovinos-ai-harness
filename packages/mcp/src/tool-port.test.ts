// SPDX-License-Identifier: Apache-2.0
import {
  InMemoryTransport,
  ProtocolError,
  type CallToolRequest,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/client";
import { context as otelContext, trace } from "@opentelemetry/api";
import { McpServer } from "@modelcontextprotocol/server";
import { JsonValue, ServerConfigSchema } from "@harness/schemas";
import {
  createTestContextManager,
  createTestSpanCollector,
} from "@harness/telemetry/testing";
import { lookupSpanDefinition } from "@harness/telemetry";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { McpConnection } from "./connection.js";
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
  close(): Promise<void>;
}

async function fixture(options: {
  readonly result?: CallToolResult;
  readonly protocolError?: number;
  readonly neverResolve?: boolean;
  readonly callMs?: number;
  readonly maxResultBytes?: number;
} = {}): Promise<Fixture> {
  const [client, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = new McpServer({ name: "tool-port-test", version: "1.0.0" });
  const calls: CallToolRequest["params"][] = [];
  server.server.registerCapabilities({ tools: { listChanged: true } });
  server.server.setRequestHandler("tools/list", () => ({
    tools: [{ name: "echo", inputSchema }],
  }));
  server.server.setRequestHandler("tools/call", (request) => {
    calls.push(request.params);
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
  const port = await McpToolPort.create([config], {
    resolveSecret: () => Promise.reject(new Error("unexpected secret")),
    createTransport: () => client,
  });
  return {
    peer,
    port,
    calls,
    close: async () => {
      await port.close();
      await serverTransport.close();
    },
  };
}

function context(signal = new AbortController().signal) {
  return { signal };
}

const call = { callId: "00000000000000000000000000", toolId: "mcp_test.echo", args: { value: "ok" } };

beforeAll(() => {
  otelContext.setGlobalContextManager(createTestContextManager());
  trace.setGlobalTracerProvider(spanCollector.provider);
});

afterAll(() => {
  otelContext.disable();
  trace.disable();
});

describe("McpToolPort", () => {
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
      expect(
        lookupSpanDefinition("mcp.client.call")?.shape,
      ).toHaveProperty("mcp.method.name");
    } finally {
      await current.close();
    }
  });

  it("maps isError to a code and drops untrusted error text", async () => {
    const current = await fixture({
      result: { isError: true, content: [{ type: "text", text: canary }] },
    });
    try {
      const result = await current.port.execute(call, context());
      expect(result).toEqual({
        outcome: "error",
        errorCode: "tool_reported_error",
        result: null,
      });
      expect(JSON.stringify(result)).not.toContain(canary);
      expect(
        spanCollector.getFinishedSpans().at(-1)?.attributes["harness.outcome"],
      ).toBe("error");
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
        content: [{ type: "image", mimeType: "image/png", data: Buffer.from([1, 2]).toString("base64") }],
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

  it("marks large binary results for offloading without returning raw blocks", async () => {
    const current = await fixture({
      result: {
        content: [
          { type: "audio", mimeType: "audio/wav", data: Buffer.alloc(9_000, 1).toString("base64") },
        ],
      },
    });
    try {
      const result = await current.port.execute(call, context());
      expect(result.outcome).toBe("ok");
      expect(result.binary).toBe(true);
      expect(Array.isArray(result.result)).toBe(true);
      expect(JsonValue.safeParse(result.result).success).toBe(true);
      expect(JSON.stringify(result)).not.toContain(Buffer.alloc(9_000, 1).toString("base64"));
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

  it("preserves input-required results as successful handoff markers", async () => {
    const current = await fixture();
    const callTool = vi.spyOn(McpConnection.prototype, "callTool").mockResolvedValue({
      content: [],
      resultType: "input_required",
    } as CallToolResult);
    try {
      await expect(current.port.execute(call, context())).resolves.toEqual({
        outcome: "ok",
        result: { resultType: "input_required" },
      });
    } finally {
      callTool.mockRestore();
      await current.close();
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
      } as CallToolResult,
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
          content: [{ type: "resource", mimeType: "application/octet-stream", bytes: 2, data: "AQI=" }],
        },
      });
    } finally {
      await current.close();
    }
  });
});
