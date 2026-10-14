// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import { context as otelContext, trace } from "@opentelemetry/api";
import {
  FakeClock,
  Id,
  JsonValue,
  PiiConfigSchema,
  RunConfigSchema,
  SequentialIdGenerator,
  ServerConfigSchema,
  type Event,
} from "@harness/schemas";
import { createRuntime, type ModelCompletion } from "@harness/core";
import {
  CrashingEventStore,
  FakeModelPort,
  SimulatedCrash,
  allowAllPolicy,
} from "@harness/core/testing";
import { McpToolPort, type McpToolExecutionResult, type McpLogger } from "@harness/mcp";
import { createTestContextManager, createTestSpanCollector } from "@harness/telemetry/testing";
import { InMemoryEventStore, type EventStore } from "@harness/store";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createCanaries } from "./canary/canaries.js";

const spanCollector = createTestSpanCollector();
const serverUrl = "http://127.0.0.1:3333/mcp";
const runId = Id.parse("00000000000000000000000000");
const sendMessageCallId = Id.parse("00000000000000000000000010");

const idempotentToolNames = [
  "echo",
  "slow",
  "fail",
  "big",
  "trace_probe",
  "get_spans",
  "get_count",
  "reset_count",
];

function serverConfig(trust: "internal" | "external" = "internal") {
  return ServerConfigSchema.parse({
    id: "sample_mcp",
    transport: { kind: "http", url: serverUrl },
    protocol: "auto",
    trust,
    propagateTrace: trust === "internal",
    idempotentTools: idempotentToolNames,
    timeouts: { connectMs: 5_000, callMs: 15_000 },
    maxResultBytes: 1_048_576,
  });
}

async function createPort(options: { readonly logs?: string[] } = {}): Promise<McpToolPort> {
  const logger: McpLogger = {
    log: (event) => {
      options.logs?.push(JSON.stringify(event));
    },
  };
  return McpToolPort.create([serverConfig()], {
    resolveSecret: () => Promise.reject(new Error("unexpected secret")),
    logger,
  });
}

async function callTool(
  port: McpToolPort,
  name: string,
  args: JsonValue = {},
  signal = new AbortController().signal,
): Promise<McpToolExecutionResult> {
  return port.execute(
    {
      callId: sendMessageCallId,
      toolId: `sample_mcp.${name}`,
      args,
    },
    { signal },
  );
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resultValue(result: McpToolExecutionResult): JsonValue {
  const decoded = JsonValue.parse(result.result);
  if (!isRecord(decoded) || !Array.isArray(decoded.content)) {
    throw new TypeError("The sample MCP server returned an invalid tool result.");
  }
  const first = decoded.content[0];
  if (!isRecord(first) || typeof first.text !== "string") {
    throw new TypeError("The sample MCP server returned an invalid text result.");
  }
  return JsonValue.parse(JSON.parse(first.text));
}

function objectResult(result: McpToolExecutionResult): Record<string, JsonValue> {
  const value = resultValue(result);
  if (!isRecord(value)) {
    throw new TypeError("The sample MCP server returned a non-object tool result.");
  }
  return value;
}

function completion(parts: ModelCompletion["parts"]): ModelCompletion {
  return {
    parts,
    usage: { inputTokens: 1, outputTokens: 1 },
    finishReason: parts.some((part) => part.type === "tool_call") ? "tool_calls" : "stop",
    provider: "sample-test",
    model: "sample-test",
    latencyMs: 0,
    schemaValid: true,
    repairAttempts: 0,
    fallbackDepth: 0,
    providerBlobs: null,
  };
}

function modelForToolCall(toolId: string, args: JsonValue): FakeModelPort {
  return new FakeModelPort([
    completion([
      {
        type: "tool_call",
        callId: sendMessageCallId,
        toolId,
        args,
      },
    ]),
    completion([{ type: "text", text: "finished" }]),
  ]);
}

function runtimeConfig(options: { readonly detokenizeFailInput?: boolean } = {}) {
  return {
    run: RunConfigSchema.parse({
      checkpointEveryEvents: 20,
      resume: { onNonIdempotent: "escalate" },
    }),
    pii: PiiConfigSchema.parse({
      ...(options.detokenizeFailInput === true
        ? { detokenize: [{ toolId: "sample_mcp.fail", args: ["/value"] }] }
        : { enabled: false }),
    }),
  };
}

async function readEvents(store: EventStore, forRun: Id): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of store.read(forRun)) {
    events.push(event);
  }
  return events;
}

function captureAppendBoundaries(
  store: InMemoryEventStore,
  boundaries: (readonly Event["type"][])[],
): void {
  const append = store.append.bind(store);
  vi.spyOn(store, "append").mockImplementation((forRun, events, expectedSeq) => {
    boundaries.push(events.map(({ type }) => type));
    return append(forRun, events, expectedSeq);
  });
  const appendWithSnapshot = store.appendWithSnapshot.bind(store);
  vi.spyOn(store, "appendWithSnapshot").mockImplementation(
    (forRun, events, expectedSeq, snapshot) => {
      boundaries.push(events.map(({ type }) => type));
      return appendWithSnapshot(forRun, events, expectedSeq, snapshot);
    },
  );
}

beforeAll(() => {
  otelContext.setGlobalContextManager(createTestContextManager());
  trace.setGlobalTracerProvider(spanCollector.provider);
});

afterAll(() => {
  otelContext.disable();
  trace.disable();
});

describe("sample MCP server integration", () => {
  it("propagates only trusted trace context and verifies real server parent linkage", async () => {
    const port = await createPort();
    try {
      const before = spanCollector.getFinishedSpans().length;
      const probe = await callTool(port, "trace_probe");
      const callSpans = spanCollector
        .getFinishedSpans()
        .slice(before)
        .filter(({ name }) => name === "mcp.client.call");
      const callSpan = callSpans[0];
      expect(callSpan).toBeDefined();
      if (callSpan === undefined) {
        throw new TypeError("The trusted MCP call span was not exported.");
      }
      const spanContext = callSpan.spanContext();
      const traceparent = `00-${spanContext.traceId}-${spanContext.spanId}-${spanContext.traceFlags.toString(16).padStart(2, "0")}`;
      const probeValue = objectResult(probe);
      expect(probeValue).toMatchObject({
        receivedTraceparent: traceparent,
        hasBaggage: false,
        childParentSpanId: spanContext.spanId,
      });

      const spans = await callTool(port, "get_spans");
      expect(spans.outcome).toBe("ok");
      const serverSpans = resultValue(spans);
      if (!Array.isArray(serverSpans)) {
        throw new TypeError("The sample MCP server returned an invalid span list.");
      }
      expect(
        serverSpans.some(
          (span: unknown) =>
            isRecord(span) &&
            span.name === "sample_mcp.trace_probe" &&
            span.parentSpanId === spanContext.spanId,
        ),
      ).toBe(true);
    } finally {
      await port.close();
    }
  });

  it("does not send trace context to external servers", async () => {
    const port = await McpToolPort.create([serverConfig("external")], {
      resolveSecret: () => Promise.reject(new Error("unexpected secret")),
    });
    try {
      const probe = await callTool(port, "trace_probe");
      expect(objectResult(probe)).toMatchObject({
        receivedTraceparent: null,
        hasBaggage: false,
        childParentSpanId: null,
      });
    } finally {
      await port.close();
    }
  });

  it("keeps server error canaries out of events, spans, and logs", async () => {
    const canary = createCanaries(randomUUID()).email.value;
    const logs: string[] = [];
    const port = await createPort({ logs });
    const before = spanCollector.getFinishedSpans().length;
    try {
      const raw = await callTool(port, "fail", JsonValue.parse({ value: canary }));
      expect(raw.outcome).toBe("error");
      expect(JSON.stringify(raw.result)).toContain(canary);

      const runtime = await createRuntime(runtimeConfig({ detokenizeFailInput: true }), {
        store: new InMemoryEventStore(),
        transientVault: true,
        clock: new FakeClock(100),
        ids: new SequentialIdGenerator(),
        model: modelForToolCall("sample_mcp.fail", JsonValue.parse({ value: canary })),
        tool: port,
        policy: allowAllPolicy,
      });
      try {
        const result = await runtime.run("check sample server error privacy");
        expect(result.events.some((event) => event.type === "tool_result")).toBe(true);
        expect(JSON.stringify(result.events)).not.toContain(canary);
      } finally {
        await runtime.close();
      }

      expect(
        JSON.stringify(
          spanCollector
            .getFinishedSpans()
            .slice(before)
            .map(({ name, attributes, status }) => ({ name, attributes, status })),
        ),
      ).not.toContain(canary);
      expect(logs.join("\n")).not.toContain(canary);
    } finally {
      await port.close();
    }
  });

  it("maps a 2 MiB tool result to result_too_large", async () => {
    const port = await createPort();
    try {
      await expect(callTool(port, "big")).resolves.toMatchObject({
        outcome: "error",
        errorCode: "result_too_large",
      });
    } finally {
      await port.close();
    }
  });

  it("cancels a slow tool call when its signal is aborted", async () => {
    const port = await createPort();
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, 100);
    try {
      await expect(
        callTool(port, "slow", JsonValue.parse({ milliseconds: 10_000 }), controller.signal),
      ).resolves.toMatchObject({ outcome: "error", errorCode: "mcp_timeout" });
    } finally {
      clearTimeout(timeout);
      await port.close();
    }
  });

  it("executes a non-idempotent message once when resuming after a crash", async () => {
    const port = await createPort();
    const referenceStore = new InMemoryEventStore();
    const referenceBoundaries: (readonly Event["type"][])[] = [];
    captureAppendBoundaries(referenceStore, referenceBoundaries);
    const referenceRuntime = await createRuntime(runtimeConfig(), {
      store: referenceStore,
      clock: new FakeClock(100),
      ids: new SequentialIdGenerator(),
      model: modelForToolCall(
        "sample_mcp.send_message",
        JsonValue.parse({ message: "synthetic crash-resume message" }),
      ),
      tool: port,
      policy: allowAllPolicy,
    });
    const crashedStore = new InMemoryEventStore();
    let crashAt = 0;
    let crashedRuntime: Awaited<ReturnType<typeof createRuntime>> | undefined;
    let resumedRuntime: Awaited<ReturnType<typeof createRuntime>> | undefined;
    try {
      await referenceRuntime.run("discover tool result append boundary");
      crashAt = referenceBoundaries.findIndex((types) => types.includes("tool_result")) + 1;
      expect(crashAt).toBeGreaterThan(0);
      await callTool(port, "reset_count");

      const crashStore = new CrashingEventStore(crashedStore, {
        crashAt,
        mode: "before_commit",
      });
      crashedRuntime = await createRuntime(runtimeConfig(), {
        store: crashStore,
        clock: new FakeClock(100),
        ids: new SequentialIdGenerator(),
        model: modelForToolCall(
          "sample_mcp.send_message",
          JsonValue.parse({ message: "synthetic crash-resume message" }),
        ),
        tool: port,
        policy: allowAllPolicy,
      });
      await expect(crashedRuntime.run("crash after non-idempotent tool execution")).rejects.toBeInstanceOf(
        SimulatedCrash,
      );
      const initialEvents = await readEvents(crashStore, runId);
      expect(initialEvents.some((event) => event.type === "tool_intent")).toBe(true);
      expect(initialEvents.some((event) => event.type === "tool_result")).toBe(false);

      resumedRuntime = await createRuntime(runtimeConfig(), {
        store: crashStore,
        clock: new FakeClock(100),
        ids: new SequentialIdGenerator(),
        model: modelForToolCall(
          "sample_mcp.send_message",
          JsonValue.parse({ message: "synthetic crash-resume message" }),
        ),
        tool: port,
        policy: allowAllPolicy,
      });
      expect((await resumedRuntime.resume(runId)).status).toBe("suspended");
      expect(objectResult(await callTool(port, "get_count")).count).toBe(1);
    } finally {
      await referenceRuntime.close();
      await resumedRuntime?.close();
      await crashedRuntime?.close();
      await port.close();
    }
  });
});
