// SPDX-License-Identifier: Apache-2.0
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createServer as createHttpServer } from "node:http";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { propagation, ROOT_CONTEXT, trace } from "@opentelemetry/api";
import type { TextMapGetter } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  createMcpHandler,
  McpServer,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/server";
import { sampleFailureText } from "../sample-mcp-failure.js";

const counterPath = process.env.SAMPLE_COUNTER_FILE ?? "/data/messages.count";
const tracer = trace.getTracer("sample-mcp-server");
const propagator = new W3CTraceContextPropagator();
const carrierGetter: TextMapGetter<Record<string, string>> = {
  get: (carrier, key) => carrier[key],
  keys: (carrier) => Object.keys(carrier),
};
const finishedServerSpans: { readonly name: string; readonly parentSpanId: string | null }[] = [];

type SampleToolHandler = (
  args: Record<string, unknown>,
  signal: AbortSignal,
  meta: unknown,
) => CallToolResult | Promise<CallToolResult>;

propagation.setGlobalPropagator(propagator);

const noArgsSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
} satisfies Tool["inputSchema"];
const valueSchema = {
  type: "object",
  properties: { value: { type: "string" } },
  required: ["value"],
  additionalProperties: false,
} satisfies Tool["inputSchema"];
const slowSchema = {
  type: "object",
  properties: { milliseconds: { type: "integer", minimum: 0, maximum: 60_000 } },
  required: ["milliseconds"],
  additionalProperties: false,
} satisfies Tool["inputSchema"];
const messageSchema = {
  type: "object",
  properties: { message: { type: "string" } },
  required: ["message"],
  additionalProperties: false,
} satisfies Tool["inputSchema"];
const tools = [
  { name: "echo", description: "Return the supplied value.", inputSchema: valueSchema },
  {
    name: "send_message",
    description: "Persist a message and increment the test counter.",
    inputSchema: messageSchema,
  },
  { name: "slow", description: "Wait for a bounded interval.", inputSchema: slowSchema },
  { name: "fail", description: "Return a synthetic tool error.", inputSchema: valueSchema },
  { name: "big", description: "Return a 2 MiB text result.", inputSchema: noArgsSchema },
  {
    name: "trace_probe",
    description: "Report received trace context and the child span parent.",
    inputSchema: noArgsSchema,
  },
  { name: "get_spans", description: "Test-only finished server spans.", inputSchema: noArgsSchema },
  { name: "get_count", description: "Test-only persisted message count.", inputSchema: noArgsSchema },
  { name: "reset_count", description: "Test-only reset of the message count.", inputSchema: noArgsSchema },
] satisfies Tool[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textResult(value: unknown): CallToolResult {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

function traceProbe(metaValue: unknown): CallToolResult {
  const meta = isRecord(metaValue) ? metaValue : {};
  const receivedTraceparent = typeof meta.traceparent === "string" ? meta.traceparent : null;
  const carrier = receivedTraceparent === null ? {} : { traceparent: receivedTraceparent };
  const parentContext = propagation.extract(ROOT_CONTEXT, carrier, carrierGetter);
  const parentSpanId = trace.getSpanContext(parentContext)?.spanId ?? null;
  const span = { name: "sample_mcp.trace_probe", parentSpanId };
  tracer.startActiveSpan(span.name, {}, parentContext, (child) => {
    child.end();
    finishedServerSpans.push(span);
  });
  return textResult({
    receivedTraceparent,
    hasBaggage: propagation.getBaggage(parentContext) !== undefined,
    childParentSpanId: span.parentSpanId,
  });
}

async function slowTool(args: Record<string, unknown>, signal: AbortSignal): Promise<CallToolResult> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, Number(args.milliseconds));
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
  return textResult({ cancelled: signal.aborted });
}

function readCounter(): number {
  try {
    const count = Number(readFileSync(counterPath, "utf8"));
    return Number.isSafeInteger(count) && count >= 0 ? count : 0;
  } catch {
    return 0;
  }
}

function writeCounter(value: number): void {
  mkdirSync(dirname(counterPath), { recursive: true });
  writeFileSync(counterPath, String(value), "utf8");
}

const toolHandlers: Record<string, SampleToolHandler> = {
  echo: (args) => textResult({ value: args.value }),
  send_message: (args) => {
    const count = readCounter() + 1;
    writeCounter(count);
    return textResult({ count, message: args.message });
  },
  slow: (args, signal) => slowTool(args, signal),
  fail: (args) => ({
    content: [{ type: "text", text: sampleFailureText(String(args.value)) }],
    isError: true,
  }),
  big: () => ({ content: [{ type: "text", text: "x".repeat(2 * 1024 * 1024) }] }),
  trace_probe: (_args, _signal, meta) => traceProbe(meta),
  get_spans: () => textResult(finishedServerSpans),
  get_count: () => textResult({ count: readCounter() }),
  reset_count: () => {
    writeCounter(0);
    return textResult({ count: 0 });
  },
};

function createServer(): McpServer {
  const server = new McpServer({ name: "sample-mcp-server", version: "1.0.0" });
  server.server.registerCapabilities({ tools: { listChanged: true } });
  server.server.setRequestHandler("tools/list", () => ({ tools }));
  server.server.setRequestHandler("tools/call", (request, extra) => {
    const args = isRecord(request.params.arguments) ? request.params.arguments : {};
    const handler = toolHandlers[request.params.name];
    return handler === undefined
      ? { content: [{ type: "text", text: "unknown tool" }], isError: true }
      : handler(args, extra.mcpReq.signal, request.params._meta);
  });
  return server;
}

const handler = createMcpHandler(() => createServer());
const nodeHandler = toNodeHandler(handler);
const httpServer = createHttpServer((request, response) => {
  void nodeHandler(
    {
      method: request.method ?? "GET",
      url: request.url ?? "/",
      headers: request.headers,
      [Symbol.asyncIterator]: () => request[Symbol.asyncIterator](),
    },
    response,
  );
});
httpServer.listen(3333, "0.0.0.0");
