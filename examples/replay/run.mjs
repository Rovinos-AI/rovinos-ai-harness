// SPDX-License-Identifier: Apache-2.0
import { context, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { createRuntime } from "@harness/core";
import { FakeModelPort } from "@harness/core/testing";
import {
  KeysConfigSchema,
  PiiConfigSchema,
  RunConfigSchema,
  TelemetryConfigSchema,
} from "@harness/schemas";
import { InMemoryEventStore } from "@harness/store";
import { createTestContextManager } from "@harness/telemetry/testing";
import { createTelemetrySdk } from "@harness/telemetry";
import { replayRun, resolveRun } from "@harness/replay";

const canary = "REPLAY_CANARY_21_11_SYNTHETIC";
const exportedSpans = [];
const exportedLogs = [];

function captureExporter(records) {
  return {
    export: (batch, callback) => {
      records.push(...batch);
      callback({ code: 0 });
    },
    forceFlush: () => Promise.resolve(),
    shutdown: () => Promise.resolve(),
  };
}

function requireExample(condition) {
  if (!condition) {
    throw new Error("replay_example_assertion_failed");
  }
}

async function runExample() {
  trace.disable();
  context.disable();
  const telemetry = createTelemetrySdk({
    spanExporter: captureExporter(exportedSpans),
    logExporter: captureExporter(exportedLogs),
    telemetry: TelemetryConfigSchema.parse({
      sentinel: { enabled: false },
      correlation: { enabled: false },
    }),
  });
  requireExample(trace.setGlobalTracerProvider(telemetry.tracerProvider));
  logs.setGlobalLoggerProvider(telemetry.loggerProvider);
  requireExample(context.setGlobalContextManager(createTestContextManager()));

  const config = {
    run: RunConfigSchema.parse({}),
    keys: KeysConfigSchema.parse({
      currentKeyId: "replay-example",
      keys: [{ id: "replay-example", secret: "env:REPLAY_EXAMPLE_KEY" }],
    }),
    pii: PiiConfigSchema.parse({ defaultAction: "tokenize" }),
  };
  let runtime;
  let runtimeClosed = false;
  try {
    runtime = await createRuntime(config, {
      store: new InMemoryEventStore(),
      model: new FakeModelPort([
        {
          parts: [{ type: "text", text: "The synthetic request is complete." }],
          usage: { inputTokens: 1, outputTokens: 1 },
          finishReason: "stop",
          provider: "synthetic",
          model: "synthetic",
          latencyMs: 0,
          schemaValid: true,
          repairAttempts: 0,
          fallbackDepth: 0,
          providerBlobs: null,
        },
      ]),
      sandboxBackend: {
        exec: () => Promise.reject(new Error("replay_example_sandbox_unused")),
      },
      transientVault: true,
      secretResolver: {
        resolve: () => Promise.resolve({ reveal: () => Buffer.alloc(32, 31).toString("base64") }),
      },
    });

    const original = await runtime.run(`Summarize this contact: ${canary}`);
    requireExample(original.status === "completed");
    const originalRunId = original.events[0]?.runId;
    requireExample(originalRunId !== undefined);
    const originalEvents = [];
    for await (const event of runtime.store.read(originalRunId)) {
      originalEvents.push(event);
    }
    requireExample(JSON.stringify(originalEvents).includes(canary));
    await telemetry.forceFlush();

    const originalSpan = exportedSpans.find(
      ({ name, attributes }) =>
        name === "harness.run" && attributes["harness.run.id"] === originalRunId,
    );
    requireExample(originalSpan !== undefined);
    const traceId = originalSpan.spanContext().traceId;
    const resolved = await resolveRun({ store: runtime.store, traceId });
    const replay = await replayRun(resolved, { config });
    await telemetry.forceFlush();

    const sameEventKinds =
      JSON.stringify(originalEvents.map(({ type }) => type)) ===
      JSON.stringify(replay.events.map(({ type }) => type));
    const replaySpan = exportedSpans.find(({ name }) => name === "harness.replay");
    const replayCreated = replay.events.find(({ type }) => type === "run_created");

    runtimeClosed = true;
    await runtime.close();
    await telemetry.forceFlush();

    requireExample(replay.status === original.status);
    requireExample(sameEventKinds);
    requireExample(
      replaySpan?.links.some(({ context: linked }) => linked.traceId === traceId) === true,
    );
    requireExample(replayCreated?.replayOf === originalRunId);
    const telemetryPayload = JSON.stringify({ spans: exportedSpans, logs: exportedLogs });
    requireExample(!telemetryPayload.includes(canary));

    process.stdout.write(
      [
        `Original trace ID: ${traceId}`,
        `Run status: ${original.status}`,
        `Replay status: ${replay.status}`,
        `Replay trace ID: ${replaySpan.spanContext().traceId}`,
        `Run events reproduced: ${sameEventKinds ? "yes" : "no"}`,
        `Replay trace linked: ${replaySpan === undefined ? "no" : "yes"}`,
        "Canary in exported spans/logs: absent",
      ].join("\n") + "\n",
    );
  } finally {
    if (runtime !== undefined && !runtimeClosed) {
      runtimeClosed = true;
      await runtime.close();
    }
    await telemetry.forceFlush();
    await Promise.all([telemetry.tracerProvider.shutdown(), telemetry.loggerProvider.shutdown()]);
    context.disable();
    trace.disable();
  }
}

runExample().catch((error) => {
  const code =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[a-z0-9_.-]{1,64}$/u.test(error.code)
      ? error.code
      : "replay_example_failed";
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
});
