// SPDX-License-Identifier: Apache-2.0
import { TelemetryConfigSchema } from "@rovinos/schemas";
import { metrics } from "@opentelemetry/api";
import { ExportResultCode } from "@opentelemetry/core";
import { InMemoryLogRecordExporter } from "@opentelemetry/sdk-logs";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
  type PushMetricExporter,
} from "@opentelemetry/sdk-metrics";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "node:process";
import { countHostAppRejected, countModelUsage } from "./metrics.js";
import { SentinelRequiredError } from "./sentinel/gate.js";
import { createTelemetrySdk } from "./sdk.js";
import { SEMCONV_STABILITY_OPT_IN } from "./semconv.js";

function exporters() {
  return {
    spanExporter: new InMemorySpanExporter(),
    logExporter: new InMemoryLogRecordExporter(),
  };
}

beforeEach(() => {
  vi.stubEnv("OTEL_SEMCONV_STABILITY_OPT_IN", undefined);
  vi.stubEnv("OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT", undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("createTelemetrySdk", () => {
  it("does not build an SDK pipeline without a gate unless explicitly disabled outside production", async () => {
    expect(() =>
      createTelemetrySdk({
        spanExporter: new InMemorySpanExporter(),
        logExporter: new InMemoryLogRecordExporter(),
      }),
    ).toThrow(SentinelRequiredError);

    const sdk = createTelemetrySdk({
      ...exporters(),
      telemetry: TelemetryConfigSchema.parse({ sentinel: { enabled: false } }),
    });
    await sdk.forceFlush();
    await sdk.shutdown();
  });

  it("pins the semantic-convention stability opt-in during bootstrap", async () => {
    const sdk = createTelemetrySdk({
      ...exporters(),
      telemetry: TelemetryConfigSchema.parse({ sentinel: { enabled: false } }),
    });

    expect(env.OTEL_SEMCONV_STABILITY_OPT_IN).toBe(SEMCONV_STABILITY_OPT_IN);
    await sdk.shutdown();
  });

  it("preserves an operator-provided semantic-convention opt-in", async () => {
    const operatorSetting = "gen_ai_latest_experimental";
    vi.stubEnv("OTEL_SEMCONV_STABILITY_OPT_IN", operatorSetting);
    const sdk = createTelemetrySdk({
      ...exporters(),
      telemetry: TelemetryConfigSchema.parse({ sentinel: { enabled: false } }),
    });

    expect(env.OTEL_SEMCONV_STABILITY_OPT_IN).toBe(operatorSetting);
    await sdk.shutdown();
  });

  it("defaults GenAI message content capture to false", async () => {
    const sdk = createTelemetrySdk({
      ...exporters(),
      telemetry: TelemetryConfigSchema.parse({ sentinel: { enabled: false } }),
    });

    expect(env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT).toBe("false");
    await sdk.shutdown();
  });

  it.each(["true", "span_only", "event_only", "span_and_event"])(
    "rejects GenAI message content capture mode %s",
    (captureMode) => {
      vi.stubEnv("OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT", captureMode);

      expect(() =>
        createTelemetrySdk({
          ...exporters(),
          telemetry: TelemetryConfigSchema.parse({ sentinel: { enabled: false } }),
        }),
      ).toThrow("telemetry_content_capture_enabled");
    },
  );

  it("shares one owned provider across repeated initialization without replacing the global provider", async () => {
    const originalProvider = metrics.getMeterProvider();
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const telemetry = TelemetryConfigSchema.parse({ sentinel: { enabled: false } });
    const first = createTelemetrySdk({ ...exporters(), metricExporter: exporter, telemetry });
    const second = createTelemetrySdk({ ...exporters(), metricExporter: exporter, telemetry });

    try {
      countHostAppRejected("schema");
      await second.forceFlush();
      expect(metrics.getMeterProvider()).toBe(originalProvider);
      expect(
        exporter
          .getMetrics()
          .flatMap(({ scopeMetrics }) =>
            scopeMetrics.flatMap(({ metrics: entries }) => entries),
          )
          .some(({ descriptor }) => descriptor.name === "harness.host.app_rejected"),
      ).toBe(true);

      await first.shutdown();
      countHostAppRejected("rate");
      await second.forceFlush();
      expect(exporter.getMetrics().length).toBeGreaterThan(1);
    } finally {
      await Promise.all([first.shutdown(), second.shutdown()]);
    }
  });

  it("does not export metrics when explicitly disabled", async () => {
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const sdk = createTelemetrySdk({
      ...exporters(),
      metricExporter: exporter,
      telemetry: TelemetryConfigSchema.parse({
        sentinel: { enabled: false },
        metrics: { enabled: false },
      }),
    });

    try {
      countHostAppRejected("schema");
      await sdk.forceFlush();
      expect(exporter.getMetrics()).toEqual([]);
    } finally {
      await sdk.shutdown();
    }
  });

  it("applies the configured per-instrument series limit", async () => {
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const sdk = createTelemetrySdk({
      ...exporters(),
      metricExporter: exporter,
      telemetry: TelemetryConfigSchema.parse({
        sentinel: { enabled: false },
        metrics: { maxSeries: 2 },
      }),
    });

    try {
      for (const provider of ["sample_a", "sample_b", "sample_c"]) {
        countModelUsage({ inputTokens: 1, outputTokens: 1 }, provider, "model");
      }
      await sdk.forceFlush();
      const metricData = exporter
        .getMetrics()
        .flatMap(({ scopeMetrics }) =>
          scopeMetrics.flatMap(({ metrics: entries }) => entries),
        )
        .find(({ descriptor }) => descriptor.name === "harness.model.tokens");
      expect(metricData?.dataPoints.length).toBeLessThanOrEqual(2);
      expect(JSON.stringify(metricData).toLowerCase()).not.toContain("exemplar");
    } finally {
      await sdk.shutdown();
    }
  });

  it("uses a host-owned global provider without replacing or shutting it down", async () => {
    const hostExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const hostProvider = new MeterProvider({
      readers: [
        new PeriodicExportingMetricReader({
          exporter: hostExporter,
          exportIntervalMillis: 60_000,
        }),
      ],
    });
    const harnessExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    expect(metrics.setGlobalMeterProvider(hostProvider)).toBe(true);
    const sdk = createTelemetrySdk({
      ...exporters(),
      metricExporter: harnessExporter,
      telemetry: TelemetryConfigSchema.parse({
        sentinel: { enabled: false },
        metrics: { ownership: "host" },
      }),
    });

    try {
      countHostAppRejected("schema");
      await sdk.forceFlush();
      await hostProvider.forceFlush();
      expect(metrics.getMeterProvider()).toBe(hostProvider);
      expect(hostExporter.getMetrics().length).toBeGreaterThan(0);
      expect(harnessExporter.getMetrics()).toEqual([]);
    } finally {
      await sdk.shutdown();
      await hostProvider.shutdown();
      metrics.disable();
    }
  });

  it("contains exporter failures during flush and shutdown", async () => {
    const exporter: PushMetricExporter = {
      export: (_metricData, callback) => {
        callback({ code: ExportResultCode.FAILED });
      },
      forceFlush: () => Promise.resolve(),
      shutdown: () => Promise.reject(new Error("synthetic_exporter_failure")),
    };
    const sdk = createTelemetrySdk({
      ...exporters(),
      metricExporter: exporter,
      telemetry: TelemetryConfigSchema.parse({ sentinel: { enabled: false } }),
    });

    countHostAppRejected("schema");
    await expect(sdk.forceFlush()).resolves.toBeUndefined();
    await expect(sdk.shutdown()).resolves.toBeUndefined();
  });
});
