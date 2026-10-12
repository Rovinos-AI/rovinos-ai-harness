// SPDX-License-Identifier: Apache-2.0
import type { TelemetryConfig } from "@harness/schemas";
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
import { AllowlistLogRecordProcessor } from "./processors/allowlist-log-processor.js";
import { AllowlistSpanProcessor } from "./processors/allowlist-span-processor.js";
import { assertSentinelGate, type SentinelGate } from "./sentinel/gate.js";
import { SEMCONV_STABILITY_OPT_IN } from "./semconv.js";
import { env } from "node:process";

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
}

/**
 * Build trace and log providers with the allowlist and sentinel as the final export gate.
 *
 * @param options Exporters and sentinel configuration.
 */
export function createTelemetrySdk(options: TelemetrySdkOptions): TelemetrySdk {
  assertSentinelGate(options.gate, options.telemetry);
  // Keep stable HTTP semantic conventions selected; HTTP auto-instrumentation is disabled.
  env.OTEL_SEMCONV_STABILITY_OPT_IN = SEMCONV_STABILITY_OPT_IN;
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
  return { tracerProvider, loggerProvider };
}
