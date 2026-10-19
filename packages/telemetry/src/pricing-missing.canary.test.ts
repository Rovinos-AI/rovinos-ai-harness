// SPDX-License-Identifier: Apache-2.0
import { InMemoryLogRecordExporter } from "@opentelemetry/sdk-logs";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { Code } from "@harness/schemas";
import { describe, expect, it } from "vitest";
import { createTelemetrySdk } from "./sdk.js";
import { emitPricingCacheMissing, emitPricingMissing } from "./safe-event-logs.js";

describe("pricing_missing telemetry canary", () => {
  it("exports only the bounded provider and model attributes through the allowlist", async () => {
    const exporter = new InMemoryLogRecordExporter();
    const sdk = createTelemetrySdk({
      spanExporter: new InMemorySpanExporter(),
      logExporter: exporter,
      telemetry: {
        sentinel: { enabled: false, minValueLength: 6 },
        correlation: { enabled: false },
      },
    });

    try {
      emitPricingMissing(
        Code.parse("sample"),
        Code.parse("model_a"),
        sdk.loggerProvider.getLogger("@harness/telemetry"),
      );
      await sdk.forceFlush();

      const [record] = exporter.getFinishedLogRecords();
      expect(record?.attributes).toEqual({
        "harness.model.provider": "sample",
        "harness.model.name": "model_a",
      });
      expect(Object.keys(record?.attributes ?? {}).sort()).toEqual([
        "harness.model.name",
        "harness.model.provider",
      ]);
    } finally {
      await sdk.loggerProvider.shutdown();
      await sdk.tracerProvider.shutdown();
    }
  });

  it("exports pricing_cache_missing with only the bounded provider and model attributes", async () => {
    const exporter = new InMemoryLogRecordExporter();
    const sdk = createTelemetrySdk({
      spanExporter: new InMemorySpanExporter(),
      logExporter: exporter,
      telemetry: {
        sentinel: { enabled: false, minValueLength: 6 },
        correlation: { enabled: false },
      },
    });

    try {
      emitPricingCacheMissing(
        Code.parse("sample"),
        Code.parse("model_a"),
        sdk.loggerProvider.getLogger("@harness/telemetry"),
      );
      await sdk.forceFlush();

      const [record] = exporter.getFinishedLogRecords();
      expect(record?.eventName).toBe("harness.model.pricing_cache_missing");
      expect(record?.attributes).toEqual({
        "harness.model.provider": "sample",
        "harness.model.name": "model_a",
      });
      expect(Object.keys(record?.attributes ?? {}).sort()).toEqual([
        "harness.model.name",
        "harness.model.provider",
      ]);
    } finally {
      await sdk.loggerProvider.shutdown();
      await sdk.tracerProvider.shutdown();
    }
  });
});
