// SPDX-License-Identifier: Apache-2.0
import { logs } from "@opentelemetry/api";
import { TelemetryConfigSchema, type TelemetryConfigInput } from "@rovinos/schemas";
import { resourceFromAttributes } from "@opentelemetry/resources";
import type { PushMetricExporter } from "@opentelemetry/sdk-metrics";
import {
  BatchLogRecordProcessor,
  LoggerProvider,
  type LogRecordExporter,
} from "@opentelemetry/sdk-logs";
import { TracerProvider, BatchSpanProcessor, type SpanExporter } from "@opentelemetry/sdk-trace";
import { TelemetrySdkError } from "./errors.js";
import { AllowlistLogRecordProcessor } from "./processors/allowlist-log-processor.js";
import { AllowlistSpanProcessor } from "./processors/allowlist-span-processor.js";
import { assertSentinelGate, type SentinelGate } from "./sentinel/gate.js";
import { SEMCONV_STABILITY_OPT_IN } from "./semconv.js";
import { POLICY_VERSION } from "./generated/policy-version.js";
import { env } from "node:process";
import {
  forceFlushTelemetryMetrics,
  initializeTelemetryMetrics,
  type TelemetryMetricsLifecycle,
} from "./metrics-sdk.js";

const sdkFlushersByLoggerProvider = new WeakMap<WeakKey, () => Promise<void>>();

/** Inputs for constructing the guarded trace, log, and metric SDK providers. */
export interface TelemetrySdkOptions {
  readonly spanExporter: SpanExporter;
  readonly logExporter: LogRecordExporter;
  readonly metricExporter?: PushMetricExporter;
  readonly gate?: SentinelGate;
  readonly telemetry?: TelemetryConfigInput;
}

/** Providers created with allowlist processors and a required fail-closed sentinel. */
export interface TelemetrySdk {
  readonly tracerProvider: TracerProvider;
  readonly loggerProvider: LoggerProvider;
  /** Flush pending spans, logs, metrics, and in-flight sentinel checks. */
  forceFlush(): Promise<void>;
  /** Flush and shut down providers created by this SDK. */
  shutdown(): Promise<void>;
}

/**
 * Build trace and log providers with the allowlist and sentinel as the final export gate.
 * No auto-instrumentations or resource detectors are enabled. HTTP/undici instrumentation
 * added later produces unregistered spans, which the span processor drops.
 *
 * @param options Exporters and sentinel configuration.
 */
export function createTelemetrySdk(options: TelemetrySdkOptions): TelemetrySdk {
  const contentCapture = env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT;
  if (contentCapture === undefined) {
    env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT = "false";
  } else if (contentCapture !== "false") {
    throw new TelemetrySdkError();
  }

  const telemetry =
    options.telemetry === undefined ? undefined : TelemetryConfigSchema.parse(options.telemetry);
  assertSentinelGate(options.gate, telemetry);
  // Default to stable HTTP conventions without overriding an operator's setting.
  env.OTEL_SEMCONV_STABILITY_OPT_IN ??= SEMCONV_STABILITY_OPT_IN;
  const processorOptions = {
    ...(options.gate === undefined ? {} : { gate: options.gate }),
    ...(telemetry === undefined ? {} : { telemetry }),
  };
  const resource = resourceFromAttributes({ "harness.policy.version": POLICY_VERSION });
  const tracerProvider = new TracerProvider({
    resource,
    spanProcessors: [
      new AllowlistSpanProcessor(
        new BatchSpanProcessor({ exporter: options.spanExporter }),
        processorOptions,
      ),
    ],
  });
  const loggerProvider = new LoggerProvider({
    resource,
    processors: [
      new AllowlistLogRecordProcessor(
        new BatchLogRecordProcessor({ exporter: options.logExporter }),
        processorOptions,
      ),
    ],
  });
  const metricsLifecycle: TelemetryMetricsLifecycle = initializeTelemetryMetrics(
    (telemetry ?? TelemetryConfigSchema.parse({})).metrics,
    options.metricExporter,
  );
  const forceFlush = async (): Promise<void> => {
    await Promise.all([
      tracerProvider.forceFlush(),
      loggerProvider.forceFlush(),
      metricsLifecycle.forceFlush(),
    ]);
  };
  const flushTracesAndLogs = async (): Promise<void> => {
    await Promise.all([tracerProvider.forceFlush(), loggerProvider.forceFlush()]);
  };
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    shutdownPromise ??= Promise.all([
      tracerProvider.shutdown(),
      loggerProvider.shutdown(),
      metricsLifecycle.shutdown(),
    ]).then(() => undefined);
    return shutdownPromise;
  };
  sdkFlushersByLoggerProvider.set(loggerProvider, flushTracesAndLogs);
  return {
    tracerProvider,
    loggerProvider,
    forceFlush,
    shutdown,
  };
}

/** Flush providers belonging to the globally registered telemetry SDK. */
export async function forceFlushTelemetry(): Promise<void> {
  await Promise.all([
    sdkFlushersByLoggerProvider.get(logs.getLoggerProvider())?.() ?? Promise.resolve(),
    forceFlushTelemetryMetrics(),
  ]);
}
