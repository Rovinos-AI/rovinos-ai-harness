// SPDX-License-Identifier: Apache-2.0
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import { trace } from "@opentelemetry/api";
import { ExportResultCode } from "@opentelemetry/core";
import { Id } from "@harness/schemas";
import {
  attr,
  createTelemetrySdk,
  defineLogRecord,
  SentinelGate,
  VaultRunView,
  type TelemetrySdkOptions,
} from "@harness/telemetry";
import { __registerUnsafeSpanForTests, createTestSpanCollector } from "@harness/telemetry/testing";
import type { SqliteVault } from "@harness/vault";
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
export function createCanaryTelemetry(vault: SqliteVault): CanaryTelemetry {
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
    gate: new SentinelGate(new VaultRunView(vault), undefined, { maxPrepareMs: 1_000 }),
    telemetry: { sentinel: { minValueLength: 6, enabled: true } },
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
  logs.getLogger("@harness/telemetry").emit({
    eventName: canaryLog.name,
    severityNumber: SeverityNumber.INFO,
    attributes: {
      "harness.run.id": runId,
      "harness.error.code": canary,
    },
  });
  await telemetry.sdk.forceFlush();
}

/** Send a test-hook span through the production allowlist and sentinel processors. */
export async function emitCanaryUnsafeSpan(
  telemetry: CanaryTelemetry,
  runId: Id,
  canary: string,
): Promise<void> {
  const span = telemetry.sdk.tracerProvider
    .getTracer("@harness/canary")
    .startSpan(UNSAFE_SPAN_NAME, {
      attributes: { "harness.run.id": runId, "harness.canary.value": canary },
    });
  span.end();
  await telemetry.sdk.forceFlush();
}

/** Capture the raw value on an exporter with no allowlist processor or sentinel gate. */
export async function captureWithoutCanaryGuards(canary: string): Promise<string> {
  const unprotected = createTestSpanCollector();
  const span = unprotected.provider
    .getTracer("@harness/canary-negative-control")
    .startSpan(UNSAFE_SPAN_NAME, { attributes: { "harness.canary.value": canary } });
  span.end();
  await unprotected.provider.forceFlush();
  const payload = JSON.stringify(
    unprotected.getFinishedSpans().map(({ name, attributes }) => ({ name, attributes })),
  );
  await unprotected.provider.shutdown();
  return payload;
}
