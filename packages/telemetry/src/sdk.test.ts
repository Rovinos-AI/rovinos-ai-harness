// SPDX-License-Identifier: Apache-2.0
import { TelemetryConfigSchema } from "@rovinos/schemas";
import { InMemoryLogRecordExporter } from "@opentelemetry/sdk-logs";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "node:process";
import { SentinelRequiredError } from "./sentinel/gate.js";
import { createTelemetrySdk } from "./sdk.js";
import { SEMCONV_STABILITY_OPT_IN } from "./semconv.js";

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
      spanExporter: new InMemorySpanExporter(),
      logExporter: new InMemoryLogRecordExporter(),
      telemetry: TelemetryConfigSchema.parse({ sentinel: { enabled: false } }),
    });
    await sdk.forceFlush();
    await sdk.tracerProvider.shutdown();
    await sdk.loggerProvider.shutdown();
  });

  it("pins the semantic-convention stability opt-in during bootstrap", async () => {
    const sdk = createTelemetrySdk({
      spanExporter: new InMemorySpanExporter(),
      logExporter: new InMemoryLogRecordExporter(),
      telemetry: TelemetryConfigSchema.parse({ sentinel: { enabled: false } }),
    });

    expect(env.OTEL_SEMCONV_STABILITY_OPT_IN).toBe(SEMCONV_STABILITY_OPT_IN);
    await sdk.tracerProvider.shutdown();
    await sdk.loggerProvider.shutdown();
  });

  it("preserves an operator-provided semantic-convention opt-in", async () => {
    const operatorSetting = "gen_ai_latest_experimental";
    vi.stubEnv("OTEL_SEMCONV_STABILITY_OPT_IN", operatorSetting);
    const sdk = createTelemetrySdk({
      spanExporter: new InMemorySpanExporter(),
      logExporter: new InMemoryLogRecordExporter(),
      telemetry: TelemetryConfigSchema.parse({ sentinel: { enabled: false } }),
    });

    expect(env.OTEL_SEMCONV_STABILITY_OPT_IN).toBe(operatorSetting);
    await sdk.tracerProvider.shutdown();
    await sdk.loggerProvider.shutdown();
  });

  it("defaults GenAI message content capture to false", async () => {
    const sdk = createTelemetrySdk({
      spanExporter: new InMemorySpanExporter(),
      logExporter: new InMemoryLogRecordExporter(),
      telemetry: TelemetryConfigSchema.parse({ sentinel: { enabled: false } }),
    });

    expect(env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT).toBe("false");
    await sdk.tracerProvider.shutdown();
    await sdk.loggerProvider.shutdown();
  });

  it.each(["true", "span_only", "event_only", "span_and_event"])(
    "rejects GenAI message content capture mode %s",
    (captureMode) => {
      vi.stubEnv("OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT", captureMode);

      expect(() =>
        createTelemetrySdk({
          spanExporter: new InMemorySpanExporter(),
          logExporter: new InMemoryLogRecordExporter(),
          telemetry: TelemetryConfigSchema.parse({ sentinel: { enabled: false } }),
        }),
      ).toThrowError("telemetry_content_capture_enabled");
    },
  );
});
