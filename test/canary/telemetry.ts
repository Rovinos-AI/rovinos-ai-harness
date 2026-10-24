// SPDX-License-Identifier: Apache-2.0
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import { trace } from "@opentelemetry/api";
import { ExportResultCode } from "@opentelemetry/core";
import { Id } from "@rovinos/schemas";
import {
  attr,
  createTelemetrySdk,
  defineSpan,
  defineLogRecord,
  emitKeysRotated,
  SentinelGate,
  type VaultRunReader,
  VaultRunView,
  type TelemetrySdkOptions,
} from "@rovinos/telemetry";
import { __registerUnsafeSpanForTests } from "@rovinos/telemetry/testing";
import { z } from "zod";

const UNSAFE_SPAN_NAME = "harness.canary.unsafe";
const canaryLog = defineLogRecord("harness.canary.pipeline", {
  "harness.run.id": attr.id(),
  "harness.error.code": attr.code(),
});

type ExportedSpan = Parameters<TelemetrySdkOptions["spanExporter"]["export"]>[0][number];
type ExportedLog = Parameters<TelemetrySdkOptions["logExporter"]["export"]>[0][number];

/** Capture exporters and test-hook cleanup owned by one canary harness. */
export interface CanaryTelemetry {
  readonly sdk: ReturnType<typeof createTelemetrySdk>;
  readonly spans: ExportedSpan[];
  readonly logs: ExportedLog[];
  readonly unsafeSpanCleanup: () => void;
}

/** Install guarded telemetry exporters backed by the encrypted vault values. */
export function createCanaryTelemetry(vault: VaultRunReader): CanaryTelemetry {
  const spans: ExportedSpan[] = [];
  const records: ExportedLog[] = [];
  const sdk = createTelemetrySdk({
    spanExporter: {
      export: (finished, callback) => {
        spans.push(...finished);
        callback({ code: ExportResultCode.SUCCESS });
      },
      shutdown: () => Promise.resolve(),
    },
    logExporter: {
      export: (finished, callback) => {
        records.push(...finished);
        callback({ code: ExportResultCode.SUCCESS });
      },
      forceFlush: () => Promise.resolve(),
      shutdown: () => Promise.resolve(),
    },
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

/** Capture the raw value using the shipped allowlist processor with its sentinel disabled. */
export async function captureWithoutSentinel(canary: string): Promise<string> {
  const spans: ExportedSpan[] = [];
  const sdk = createTelemetrySdk({
    spanExporter: {
      export: (finished, callback) => {
        spans.push(...finished);
        callback({ code: ExportResultCode.SUCCESS });
      },
      shutdown: () => Promise.resolve(),
    },
    logExporter: {
      export: (_finished, callback) => {
        callback({ code: ExportResultCode.SUCCESS });
      },
      forceFlush: () => Promise.resolve(),
      shutdown: () => Promise.resolve(),
    },
    telemetry: {
      sentinel: { enabled: false, minValueLength: 6 },
      correlation: { enabled: false },
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
  await Promise.all([sdk.tracerProvider.shutdown(), sdk.loggerProvider.shutdown()]);
  return payload;
}
