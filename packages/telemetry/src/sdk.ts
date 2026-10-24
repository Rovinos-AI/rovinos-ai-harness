// SPDX-License-Identifier: Apache-2.0
import { logs } from "@opentelemetry/api-logs";
import type { TelemetryConfig } from "@rovinos/schemas";
import {
  BatchLogRecordProcessor,
  LoggerProvider,
  type LogRecordExporter,
} from "@opentelemetry/sdk-logs";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { TelemetrySdkError } from "./errors.js";
import { AllowlistLogRecordProcessor } from "./processors/allowlist-log-processor.js";
import { AllowlistSpanProcessor } from "./processors/allowlist-span-processor.js";
import { assertSentinelGate, type SentinelGate } from "./sentinel/gate.js";
import { SEMCONV_STABILITY_OPT_IN } from "./semconv.js";
import { env } from "node:process";

const sdkFlushersByLoggerProvider = new WeakMap<WeakKey, () => Promise<void>>();

/** Inputs for constructing the guarded trace and log SDK providers. */
export interface TelemetrySdkOptions {
  readonly spanExporter: SpanExporter;
  readonly logExporter: LogRecordExporter;
  readonly gate?: SentinelGate;
  readonly telemetry?: TelemetryConfig;
}

/** Providers created with allowlist processors and a required fail-closed sentinel. */
export interface TelemetrySdk {
  readonly tracerProvider: BasicTracerProvider;
  readonly loggerProvider: LoggerProvider;
  /** Flush pending span and log processors, including in-flight sentinel checks. */
  forceFlush(): Promise<void>;
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

  assertSentinelGate(options.gate, options.telemetry);
  // Default to stable HTTP conventions without overriding an operator's setting.
  env.OTEL_SEMCONV_STABILITY_OPT_IN ??= SEMCONV_STABILITY_OPT_IN;
  const processorOptions = {
    ...(options.gate === undefined ? {} : { gate: options.gate }),
    ...(options.telemetry === undefined ? {} : { telemetry: options.telemetry }),
  };
  const tracerProvider = new BasicTracerProvider({
    spanProcessors: [
      new AllowlistSpanProcessor(new BatchSpanProcessor(options.spanExporter), processorOptions),
    ],
  });
  const loggerProvider = new LoggerProvider({
    processors: [
      new AllowlistLogRecordProcessor(
        new BatchLogRecordProcessor({ exporter: options.logExporter }),
        processorOptions,
      ),
    ],
  });
  const forceFlush = async (): Promise<void> => {
    await Promise.all([tracerProvider.forceFlush(), loggerProvider.forceFlush()]);
  };
  sdkFlushersByLoggerProvider.set(loggerProvider, forceFlush);
  return {
    tracerProvider,
    loggerProvider,
    forceFlush,
  };
}

/** Flush the span and log processors belonging to the globally registered telemetry SDK. */
export async function forceFlushTelemetry(): Promise<void> {
  await sdkFlushersByLoggerProvider.get(logs.getLoggerProvider())?.();
}
