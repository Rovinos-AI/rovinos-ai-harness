// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import { createConnection, createServer as createTcpServer } from "node:net";
import { context as otelContext, trace } from "@opentelemetry/api";
import {
  FakeClock,
  Id,
  JsonValue,
  PiiConfigSchema,
  RunConfigSchema,
  SequentialIdGenerator,
  ServerConfigSchema,
  parseJson,
} from "@rovinos/schemas";
import { createRuntime } from "@rovinos/core";
import {
  CrashingEventStore,
  FakeModelPort,
  SimulatedCrash,
  allowAllPolicy,
} from "@rovinos/core/testing";
import { McpToolPort } from "@rovinos/mcp";
import { createTestContextManager, createTestSpanCollector } from "@rovinos/telemetry/testing";
import { InMemoryEventStore } from "@rovinos/store";
import { baggageTrace, spansContainCanary } from "./mcp-servers.int-support.mjs";
import { createCanaries } from "./canary/canaries.ts";

const spanCollector = createTestSpanCollector();
const serverUrl = "http://127.0.0.1:3333/mcp";
const serverHost = process.env.SAMPLE_MCP_SERVER_HOST ?? "sample-mcp-server";
const runId = Id.parse("00000000000000000000000000");
const sendMessageCallId = Id.parse("00000000000000000000000010");
let failureCode = "sample_mcp_integration_setup_failed";
const idempotentToolNames = [
  "echo",
  "slow",
  "fail",
  "big",
  "trace_probe",
  "get_spans",
  "get_cancellation",
  "get_count",
  "reset_count",
];

function serverConfig(trust = "internal") {
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

async function createPort({ logs } = {}) {
  return McpToolPort.create([serverConfig()], {
    resolveSecret: () => Promise.reject(new Error("unexpected secret")),
    logger: logs === undefined ? undefined : { log: (event) => logs.push(JSON.stringify(event)) },
  });
}

async function callTool(port, name, args = {}, signal = new AbortController().signal) {
  return port.execute(
    {
      callId: sendMessageCallId,
      toolId: `sample_mcp.${name}`,
      args,
    },
    { signal },
  );
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resultValue(result) {
  const decoded = JsonValue.parse(result.result);
  if (!isRecord(decoded) || !Array.isArray(decoded.content)) {
    throw new TypeError("The sample MCP server returned an invalid tool result.");
  }
  const first = decoded.content[0];
  if (!isRecord(first) || typeof first.text !== "string") {
    throw new TypeError("The sample MCP server returned an invalid text result.");
  }
  return parseJson(JsonValue, first.text);
}

function objectResult(result) {
  const value = resultValue(result);
  if (!isRecord(value)) {
    throw new TypeError("The sample MCP server returned a non-object tool result.");
  }
  return value;
}

function completion(parts) {
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

function modelForToolCall(toolId, args) {
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

function runtimeConfig({ detokenizeFailInput = false } = {}) {
  return {
    run: RunConfigSchema.parse({
      checkpointEveryEvents: 20,
      resume: { onNonIdempotent: "escalate" },
    }),
    pii: PiiConfigSchema.parse(
      detokenizeFailInput
        ? { detokenize: [{ toolId: "sample_mcp.fail", args: ["/value"] }] }
        : { enabled: false },
    ),
  };
}

async function readEvents(store, forRun) {
  const events = [];
  for await (const event of store.read(forRun)) {
    events.push(event);
  }
  return events;
}

class BoundaryEventStore extends InMemoryEventStore {
  constructor(boundaries) {
    super();
    this.boundaries = boundaries;
  }

  append(runId, events, expectedSeq) {
    this.boundaries.push(events.map(({ type }) => type));
    return super.append(runId, events, expectedSeq);
  }

  appendWithSnapshot(runId, events, expectedSeq, snapshot) {
    this.boundaries.push(events.map(({ type }) => type));
    return super.appendWithSnapshot(runId, events, expectedSeq, snapshot);
  }
}

async function startServerForwarder() {
  const forwarder = createTcpServer((clientSocket) => {
    const serverSocket = createConnection({ host: serverHost, port: 3333 });
    clientSocket.pipe(serverSocket);
    serverSocket.pipe(clientSocket);
    clientSocket.on("error", () => serverSocket.destroy());
    serverSocket.on("error", () => clientSocket.destroy());
  });
  await new Promise((resolve, reject) => {
    forwarder.once("error", reject);
    forwarder.listen(3333, "127.0.0.1", resolve);
  });
  return forwarder;
}

async function trustedTrace() {
  failureCode = "sample_mcp_integration_trusted_trace_connect_failed";
  const port = await createPort();
  try {
    const before = spanCollector.getFinishedSpans().length;
    failureCode = "sample_mcp_integration_trusted_trace_probe_failed";
    const probe = await callTool(port, "trace_probe");
    const callSpan = spanCollector
      .getFinishedSpans()
      .slice(before)
      .find(({ name }) => name === "mcp.client.call");
    const spanContext = callSpan?.spanContext();
    const traceparent =
      spanContext === undefined
        ? null
        : `00-${spanContext.traceId}-${spanContext.spanId}-${spanContext.traceFlags.toString(16).padStart(2, "0")}`;
    const probeValue = objectResult(probe);
    failureCode = "sample_mcp_integration_trusted_trace_export_failed";
    const serverSpans = resultValue(await callTool(port, "get_spans"));
    failureCode = "sample_mcp_integration_trusted_trace_result_failed";
    return {
      callSpanId: spanContext?.spanId ?? null,
      traceparent,
      receivedTraceparent:
        typeof probeValue.receivedTraceparent === "string" ? probeValue.receivedTraceparent : null,
      hasBaggage: probeValue.hasBaggage === true,
      childParentSpanId:
        typeof probeValue.childParentSpanId === "string" ? probeValue.childParentSpanId : null,
      serverSpanParentMatches:
        Array.isArray(serverSpans) &&
        serverSpans.some(
          (span) =>
            isRecord(span) &&
            span.name === "sample_mcp.trace_probe" &&
            span.parentSpanId === spanContext?.spanId,
        ),
    };
  } finally {
    await port.close();
  }
}

async function externalTrace() {
  const port = await McpToolPort.create([serverConfig("external")], {
    resolveSecret: () => Promise.reject(new Error("unexpected secret")),
  });
  try {
    const probeValue = objectResult(await callTool(port, "trace_probe"));
    return {
      receivedTraceparent:
        typeof probeValue.receivedTraceparent === "string" ? probeValue.receivedTraceparent : null,
      hasBaggage: probeValue.hasBaggage === true,
      childParentSpanId:
        typeof probeValue.childParentSpanId === "string" ? probeValue.childParentSpanId : null,
    };
  } finally {
    await port.close();
  }
}

async function errorPrivacy() {
  failureCode = "sample_mcp_integration_privacy_port_create_failed";
  const canary = createCanaries(randomUUID()).email.value;
  const logs = [];
  const port = await createPort({ logs });
  const before = spanCollector.getFinishedSpans().length;
  try {
    failureCode = "sample_mcp_integration_privacy_raw_call_failed";
    const raw = await callTool(port, "fail", JsonValue.parse({ value: canary }));
    failureCode = "sample_mcp_integration_privacy_runtime_create_failed";
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
      failureCode = "sample_mcp_integration_privacy_runtime_run_failed";
      const result = await runtime.run("check sample server error privacy");
      const spans = spanCollector.getFinishedSpans().slice(before);
      const exceptionBefore = spanCollector.getFinishedSpans().length;
      failureCode = "sample_mcp_integration_privacy_exception_probe_failed";
      const exceptionSpan = trace
        .getTracer("sample-mcp-integration-client")
        .startSpan("exception_canary_probe");
      exceptionSpan.recordException(new Error(canary));
      exceptionSpan.end();
      const exceptionCanaryDetected = spansContainCanary(
        spanCollector.getFinishedSpans().slice(exceptionBefore),
        canary,
      );
      return {
        outcome: raw.outcome,
        rawContainsCanary: JSON.stringify(raw.result).includes(canary),
        toolResultRecorded: result.events.some((event) => event.type === "tool_result"),
        eventsContainCanary: JSON.stringify(result.events).includes(canary),
        spansContainCanary: spansContainCanary(spans, canary),
        exceptionCanaryDetected,
        logsContainCanary: logs.join("\n").includes(canary),
      };
    } finally {
      await runtime.close();
    }
  } finally {
    await port.close();
  }
}

async function oversizedResult() {
  const port = await createPort();
  try {
    const result = await callTool(port, "big");
    return { outcome: result.outcome, errorCode: result.errorCode ?? null };
  } finally {
    await port.close();
  }
}

async function cancelledSlowCall() {
  const port = await createPort();
  const controller = new AbortController();
  const cancellationId = randomUUID();
  const timeout = setTimeout(() => controller.abort(), 100);
  try {
    const result = await callTool(
      port,
      "slow",
      JsonValue.parse({ milliseconds: 10_000, cancellationId }),
      controller.signal,
    );
    const cancellationDeadline = Date.now() + 2_000;
    let serverCancelled = false;
    while (!serverCancelled && Date.now() < cancellationDeadline) {
      serverCancelled =
        objectResult(await callTool(port, "get_cancellation", { cancellationId })).cancelled ===
        true;
      if (!serverCancelled) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    return {
      outcome: result.outcome,
      errorCode: result.errorCode ?? null,
      serverCancelled,
    };
  } finally {
    clearTimeout(timeout);
    await port.close();
  }
}

async function nonIdempotentResume() {
  const port = await createPort();
  const referenceBoundaries = [];
  const referenceStore = new BoundaryEventStore(referenceBoundaries);
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
  let crashedRuntime;
  let resumedRuntime;
  try {
    await referenceRuntime.run("discover tool result append boundary");
    crashAt = referenceBoundaries.findIndex((types) => types.includes("tool_result")) + 1;
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
    let crashType = null;
    try {
      await crashedRuntime.run("crash after non-idempotent tool execution");
    } catch (error) {
      crashType = error instanceof SimulatedCrash ? "simulated_crash" : "other";
    }
    const initialEvents = await readEvents(crashStore, runId);
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
    const resumed = await resumedRuntime.resume(runId);
    const counter = objectResult(await callTool(port, "get_count")).count;
    return {
      crashType,
      toolIntentRecorded: initialEvents.some((event) => event.type === "tool_intent"),
      toolResultRecorded: initialEvents.some((event) => event.type === "tool_result"),
      resumedStatus: resumed.status,
      counter: typeof counter === "number" ? counter : null,
    };
  } finally {
    await referenceRuntime.close();
    await resumedRuntime?.close();
    await crashedRuntime?.close();
    await port.close();
  }
}

async function run() {
  const forwarder = await startServerForwarder();
  otelContext.setGlobalContextManager(createTestContextManager());
  trace.setGlobalTracerProvider(spanCollector.provider);
  try {
    failureCode = "sample_mcp_integration_trusted_trace_failed";
    const trusted = await trustedTrace();
    failureCode = "sample_mcp_integration_external_trace_failed";
    const external = await externalTrace();
    failureCode = "sample_mcp_integration_baggage_probe_failed";
    const baggage = await baggageTrace(serverUrl);
    failureCode = "sample_mcp_integration_privacy_probe_failed";
    const privacy = await errorPrivacy();
    failureCode = "sample_mcp_integration_oversized_result_failed";
    const oversized = await oversizedResult();
    failureCode = "sample_mcp_integration_cancellation_failed";
    const cancellation = await cancelledSlowCall();
    failureCode = "sample_mcp_integration_resume_failed";
    const resume = await nonIdempotentResume();
    return {
      trusted,
      external,
      baggage,
      privacy,
      oversized,
      cancellation,
      resume,
    };
  } finally {
    otelContext.disable();
    trace.disable();
    await new Promise((resolve) => forwarder.close(resolve));
  }
}

try {
  process.stdout.write(JSON.stringify(await run()));
} catch {
  process.stderr.write(`${failureCode}\n`);
  process.exitCode = 1;
}
