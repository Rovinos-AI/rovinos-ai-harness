// SPDX-License-Identifier: Apache-2.0
import { logs, SeverityNumber, trace } from "@opentelemetry/api";

import { Code, Id } from "@rovinos/schemas";
import {
  attr,
  createTelemetrySdk,
  defineSpan,
  defineLogRecord,
  GEN_AI_PROVIDER_NAME,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS,
  GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
  emitKeysRotated,
  SentinelGate,
  type VaultRunReader,
  VaultRunView,
  type TelemetrySdkOptions,
} from "@rovinos/telemetry";
import { MODEL_CALL_SPAN } from "@rovinos/core";
import {
  __registerUnsafeSpanForTests,
  completeExportSuccessfully,
} from "@rovinos/telemetry/testing";
import { z } from "zod";

const UNSAFE_SPAN_NAME = "harness.canary.unsafe";
const canaryLog = defineLogRecord("harness.canary.pipeline", {
  "harness.run.id": attr.id(),
  "harness.error.code": attr.code(),
});

type ExportedSpan = Parameters<TelemetrySdkOptions["spanExporter"]["export"]>[0][number];
type ExportedLog = Parameters<TelemetrySdkOptions["logExporter"]["export"]>[0][number];
type ExportedMetric = Parameters<NonNullable<TelemetrySdkOptions["metricExporter"]>["export"]>[0];

/** Capture exporters and test-hook cleanup owned by one canary harness. */
export interface CanaryTelemetry {
  readonly sdk: ReturnType<typeof createTelemetrySdk>;
  readonly spans: ExportedSpan[];
  readonly logs: ExportedLog[];
  readonly metrics: ExportedMetric[];
  readonly unsafeSpanCleanup: () => void;
}

/** Install guarded telemetry exporters backed by the encrypted vault values. */
export function createCanaryTelemetry(vault: VaultRunReader): CanaryTelemetry {
  const spans: ExportedSpan[] = [];
  const records: ExportedLog[] = [];
  const metricData: ExportedMetric[] = [];
  const metricExporter: NonNullable<TelemetrySdkOptions["metricExporter"]> = {
    export: (data, callback) => {
      metricData.push(data);
      completeExportSuccessfully(callback);
    },
    forceFlush: () => Promise.resolve(),
    shutdown: () => Promise.resolve(),
  };
  const sdk = createTelemetrySdk({
    spanExporter: {
      export: (finished, callback) => {
        spans.push(...finished);
        completeExportSuccessfully(callback);
      },
      shutdown: () => Promise.resolve(),
    },
    logExporter: {
      export: (finished, callback) => {
        records.push(...finished);
        completeExportSuccessfully(callback);
      },
      forceFlush: () => Promise.resolve(),
      shutdown: () => Promise.resolve(),
    },
    metricExporter,
    // Test budgets, not the production 5 ms scan limit: on a loaded CI agent a GC pause can push one
    // scan past 5 ms, and the gate then drops the span (fail closed), so assertions on exported spans
    // flaked (#555). Fail-closed behaviour itself is covered in the gate's unit tests.
    gate: new SentinelGate(new VaultRunView(vault), undefined, {
      maxPrepareMs: 1_000,
      maxScanMs: 1_000,
    }),
    telemetry: {
      sentinel: { minValueLength: 6, enabled: true },
      correlation: { enabled: false },
      metrics: { enabled: true, ownership: "harness", maxSeries: 100 },
    },
  });
  if (!trace.setGlobalTracerProvider(sdk.tracerProvider)) {
    throw new Error("The canary tracer provider could not be registered.");
  }
  logs.setGlobalLoggerProvider(sdk.loggerProvider);
  if (logs.getLoggerProvider() !== sdk.loggerProvider) {
    throw new Error("The canary logger provider could not be registered.");
  }

  return {
    sdk,
    spans,
    logs: records,
    metrics: metricData,
    unsafeSpanCleanup: __registerUnsafeSpanForTests(UNSAFE_SPAN_NAME, {
      "harness.run.id": Id,
      "harness.canary.value": z.string(),
    }),
  };
}

/** Send a deliberately invalid canary field through the registered log pipeline. */
export async function emitCanaryBadLog(
  telemetry: CanaryTelemetry,
  runId: Id,
  canary: string,
): Promise<void> {
  logs.getLogger("@rovinos/telemetry").emit({
    eventName: canaryLog.name,
    severityNumber: SeverityNumber.INFO,
    attributes: {
      "harness.run.id": runId,
      "harness.error.code": canary,
    },
  });
  await telemetry.sdk.forceFlush();
}

/** Exercise the registered key-rotation log with counts only. */
export async function emitCanaryKeysRotated(telemetry: CanaryTelemetry): Promise<void> {
  emitKeysRotated({ vault: 3, store: 5 }, logs.getLogger("@rovinos/cli"));
  await telemetry.sdk.forceFlush();
}

/** Send a test-hook span through the production allowlist and sentinel processors. */
export async function emitCanaryUnsafeSpan(
  telemetry: CanaryTelemetry,
  runId: Id,
  canary: string,
): Promise<void> {
  const span = telemetry.sdk.tracerProvider
    .getTracer("@rovinos/canary")
    .startSpan(UNSAFE_SPAN_NAME, {
      attributes: { "harness.run.id": runId, "harness.canary.value": canary },
    });
  span.end();
  await telemetry.sdk.forceFlush();
}

/** Exercise mapped GenAI metadata and ensure content-bearing convention fields are dropped. */
export async function emitCanaryGenAiSpan(
  telemetry: CanaryTelemetry,
  runId: Id,
  canary: string,
): Promise<void> {
  const attributes = {
    "harness.run.id": runId,
    "harness.event.seq": 999,
    "harness.context.strategy": Code.parse("canary"),
    "harness.context.strategy_version": Code.parse("v1"),
    "harness.context.estimated_tokens": 0,
    "harness.context.message_count": 0,
    "harness.tool.definition_count": 0,
    "harness.tool.definition_bytes": 0,
    [GEN_AI_PROVIDER_NAME]: "synthetic",
    [GEN_AI_REQUEST_MODEL]: "synthetic_model",
    [GEN_AI_USAGE_INPUT_TOKENS]: 3,
    [GEN_AI_USAGE_OUTPUT_TOKENS]: 2,
    [GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS]: 1,
    [GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS]: 1,
  };
  const span = MODEL_CALL_SPAN.start(attributes);
  span.end();
  const contentSpan = MODEL_CALL_SPAN.start({
    ...attributes,
    "harness.event.seq": 1_000,
  });
  contentSpan.setAttribute("gen_ai.prompt", canary);
  contentSpan.setAttribute("gen_ai.input.messages", canary);
  contentSpan.setAttribute("gen_ai.output.messages", canary);
  contentSpan.setAttribute("gen_ai.tool.call.arguments", canary);
  contentSpan.setAttribute("gen_ai.tool.call.result", canary);
  contentSpan.end();
  await telemetry.sdk.forceFlush();
}

/** Capture the raw value using the shipped allowlist processor with its sentinel disabled. */
export async function captureWithoutSentinel(canary: string): Promise<string> {
  const spans: ExportedSpan[] = [];
  const sdk = createTelemetrySdk({
    spanExporter: {
      export: (finished, callback) => {
        spans.push(...finished);
        completeExportSuccessfully(callback);
      },
      shutdown: () => Promise.resolve(),
    },
    logExporter: {
      export: (_finished, callback) => {
        completeExportSuccessfully(callback);
      },
      forceFlush: () => Promise.resolve(),
      shutdown: () => Promise.resolve(),
    },
    telemetry: {
      sentinel: { enabled: false, minValueLength: 6 },
      correlation: { enabled: false },
      metrics: { enabled: true, ownership: "harness", maxSeries: 100 },
    },
  });
  const definition = defineSpan(
    "harness.canary.negative_control",
    { "harness.canary.value": attr.enum([canary]) },
    { taskId: "8.5", packageName: "@rovinos/telemetry" },
  );
  const span = sdk.tracerProvider
    .getTracer("@rovinos/canary-negative-control")
    .startSpan(definition.name, { attributes: { "harness.canary.value": canary } });
  span.end();
  await sdk.tracerProvider.forceFlush();
  const payload = JSON.stringify(spans.map(({ name, attributes }) => ({ name, attributes })));
  await sdk.shutdown();
  return payload;
}
