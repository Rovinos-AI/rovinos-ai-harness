// SPDX-License-Identifier: Apache-2.0
// Use a private harness meter so bootstrap never replaces the host's global provider.
import { TelemetryConfigSchema, type TelemetryConfig } from "@rovinos/schemas";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  createAllowListAttributesProcessor,
  MeterProvider,
  PeriodicExportingMetricReader,
  type PushMetricExporter,
} from "@opentelemetry/sdk-metrics";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { env } from "node:process";
import { TelemetryMetricsConfigError } from "./errors.js";
import { METRIC_ALLOWLIST, selectTelemetryMeterProvider } from "./metrics.js";
import { POLICY_VERSION } from "./generated/policy-version.js";

const EXPORT_INTERVAL_MS = 60_000;
const EXPORT_TIMEOUT_MS = 5_000;

interface ActiveMetrics {
  readonly config: TelemetryConfig["metrics"];
  readonly provider: MeterProvider | undefined;
  references: number;
}

/** A reference-counted handle to the process-wide harness metric pipeline. */
export interface TelemetryMetricsLifecycle {
  /** Flush pending metrics without allowing exporter failures to affect a run. */
  forceFlush(): Promise<void>;
  /** Release this owner's reference and shut down the provider when no users remain. */
  shutdown(): Promise<void>;
}

let activeMetrics: ActiveMetrics | undefined;

function metricViews(maxSeries: number) {
  return Object.entries(METRIC_ALLOWLIST).map(([instrumentName, attributes]) => ({
    instrumentName,
    meterName: "@rovinos/telemetry",
    attributesProcessors: [createAllowListAttributesProcessor([...attributes])],
    aggregationCardinalityLimit: maxSeries,
  }));
}

function createMetricReader(
  exporter: PushMetricExporter | undefined,
): PeriodicExportingMetricReader | undefined {
  const configuredExporter =
    exporter ??
    (env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT !== undefined ||
    env.OTEL_EXPORTER_OTLP_ENDPOINT !== undefined
      ? new OTLPMetricExporter()
      : undefined);
  return configuredExporter === undefined
    ? undefined
    : new PeriodicExportingMetricReader({
        exporter: configuredExporter,
        exportIntervalMillis: EXPORT_INTERVAL_MS,
        exportTimeoutMillis: EXPORT_TIMEOUT_MS,
      });
}

function sameConfig(left: TelemetryConfig["metrics"], right: TelemetryConfig["metrics"]): boolean {
  return (
    left.enabled === right.enabled &&
    left.ownership === right.ownership &&
    left.maxSeries === right.maxSeries
  );
}

async function flushProvider(provider: MeterProvider | undefined): Promise<void> {
  try {
    await provider?.forceFlush({ timeoutMillis: EXPORT_TIMEOUT_MS });
  } catch {
    return;
  }
}

function createLifecycle(metrics: ActiveMetrics): TelemetryMetricsLifecycle {
  const active = metrics;
  let released = false;
  return {
    forceFlush: () => flushProvider(active.provider),
    shutdown: async () => {
      if (released) {
        return;
      }
      released = true;
      active.references -= 1;
      if (active.references > 0) {
        return;
      }
      if (activeMetrics === active) {
        activeMetrics = undefined;
        selectTelemetryMeterProvider(undefined);
      }
      try {
        await active.provider?.shutdown({ timeoutMillis: EXPORT_TIMEOUT_MS });
      } catch {
        return;
      }
    },
  };
}

/**
 * Initializes or reuses the process metric pipeline; a host-owned provider is never replaced.
 *
 * @param config Validated metrics configuration shared by the process.
 * @param exporter Optional exporter override, primarily for embedding and tests.
 */
export function initializeTelemetryMetrics(
  config: TelemetryConfig["metrics"],
  exporter?: PushMetricExporter,
): TelemetryMetricsLifecycle {
  const parsedConfig = TelemetryConfigSchema.parse({ metrics: config }).metrics;
  if (activeMetrics !== undefined) {
    if (!sameConfig(activeMetrics.config, parsedConfig)) {
      throw new TelemetryMetricsConfigError();
    }
    activeMetrics.references += 1;
    return createLifecycle(activeMetrics);
  }

  const reader =
    parsedConfig.enabled && parsedConfig.ownership === "harness"
      ? createMetricReader(exporter)
      : undefined;
  const provider =
    parsedConfig.ownership === "host" && parsedConfig.enabled
      ? undefined
      : new MeterProvider({
          resource: resourceFromAttributes({ "harness.policy.version": POLICY_VERSION }),
          views: metricViews(parsedConfig.maxSeries),
          readers: reader === undefined ? [] : [reader],
        });
  activeMetrics = { config: parsedConfig, provider, references: 1 };
  selectTelemetryMeterProvider(provider);
  return createLifecycle(activeMetrics);
}

/** Flushes the active harness-owned provider, if one is configured. */
export function forceFlushTelemetryMetrics(): Promise<void> {
  return flushProvider(activeMetrics?.provider);
}
