// SPDX-License-Identifier: Apache-2.0
import { TelemetryConfigSchema } from "@harness/schemas";
import { InMemoryLogRecordExporter } from "@opentelemetry/sdk-logs";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";
import { SentinelRequiredError } from "./sentinel/gate.js";
import { createTelemetrySdk } from "./sdk.js";

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
    await sdk.tracerProvider.shutdown();
    await sdk.loggerProvider.shutdown();
  });
});
