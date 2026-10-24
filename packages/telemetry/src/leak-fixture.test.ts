// SPDX-License-Identifier: Apache-2.0
import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { TelemetryConfigSchema } from "@rovinos/schemas";
import { InMemoryLogRecordExporter } from "@opentelemetry/sdk-logs";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attr } from "./attr.js";
import { __resetRegistryForTests, defineSpan } from "./registry.js";
import { createTelemetrySdk } from "./sdk.js";

const disabledTelemetry = TelemetryConfigSchema.parse({ sentinel: { enabled: false } });
const allowedResourceKeys = new Set([
  "service.name",
  "service.version",
  "harness.policy.version",
  "telemetry.sdk.name",
  "telemetry.sdk.language",
  "telemetry.sdk.version",
]);
const canaries = [
  "url_query_canary",
  "exception_message_canary",
  "exception_stack_canary",
  "status_message_canary",
  "gen_ai_prompt_canary",
] as const;

afterEach(() => {
  vi.unstubAllEnvs();
  __resetRegistryForTests();
});

describe("telemetry leak fixture", () => {
  it("strips registered and unregistered auto-instrumentation leak payloads", async () => {
    vi.stubEnv("OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT", undefined);
    const spanExporter = new InMemorySpanExporter();
    const sdk = createTelemetrySdk({
      spanExporter,
      logExporter: new InMemoryLogRecordExporter(),
      telemetry: disabledTelemetry,
    });
    trace.setGlobalTracerProvider(sdk.tracerProvider);

    try {
      const definition = defineSpan(
        "harness.test.leak_fixture",
        { "harness.test.enabled": attr.bool() },
        { taskId: "4.4", packageName: "@rovinos/telemetry" },
      );
      const registered = definition.start({ "harness.test.enabled": true });
      registered.setAttribute("http.url", `https://example.test/path?secret=${canaries[0]}`);
      registered.setAttribute("exception.message", canaries[1]);
      registered.setAttribute("exception.stacktrace", canaries[2]);
      registered.setAttribute("gen_ai.prompt", canaries[4]);
      registered.addEvent("exception", {
        "exception.message": canaries[1],
        "exception.stacktrace": canaries[2],
      });
      registered.setStatus({ code: SpanStatusCode.ERROR, message: canaries[3] });
      registered.end();

      const unregistered = sdk.tracerProvider
        .getTracer("auto-instrumentation")
        .startSpan("http.request", { kind: SpanKind.CLIENT });
      unregistered.setAttribute("http.url", `https://example.test/path?secret=${canaries[0]}`);
      unregistered.setAttribute("exception.message", canaries[1]);
      unregistered.setAttribute("exception.stacktrace", canaries[2]);
      unregistered.setAttribute("gen_ai.prompt", canaries[4]);
      unregistered.addEvent("exception", {
        "exception.message": canaries[1],
        "exception.stacktrace": canaries[2],
      });
      unregistered.setStatus({ code: SpanStatusCode.ERROR, message: canaries[3] });
      unregistered.end();

      await sdk.forceFlush();

      const exported = spanExporter.getFinishedSpans();
      const serialized = JSON.stringify(exported);
      for (const canary of canaries) {
        expect(serialized).not.toContain(canary);
      }
      expect(exported).toHaveLength(1);
      expect(
        Object.keys(exported[0]?.resource.attributes ?? {}).every((key) =>
          allowedResourceKeys.has(key),
        ),
      ).toBe(true);
    } finally {
      await sdk.tracerProvider.shutdown();
      await sdk.loggerProvider.shutdown();
    }
  });
});
