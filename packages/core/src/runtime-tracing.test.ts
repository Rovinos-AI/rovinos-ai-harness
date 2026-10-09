// SPDX-License-Identifier: Apache-2.0
import { Id, RunConfigSchema } from "@harness/schemas";
import { context as otelContext, SpanStatusCode, trace } from "@opentelemetry/api";
import { InMemoryEventStore } from "@harness/store";
import { expect, it } from "vitest";
import { createRuntime } from "./runtime.js";
import { RUN_SPAN } from "./spans.js";
import { FakeModelPort } from "./testing/fake-model.js";

it("records valid span context when no OpenTelemetry provider is configured", async () => {
  const runtime = await createRuntime(
    { run: RunConfigSchema.parse({}) },
    {
      store: new InMemoryEventStore(),
      model: new FakeModelPort([
        {
          content: "answer",
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1 },
          finishReason: "stop",
          provider: "test",
          model: "test",
          latencyMs: 0,
          schemaValid: true,
          repairAttempts: 0,
          providerBlobs: null,
        },
      ]),
    },
  );

  const result = await runtime.run("goal");
  await runtime.close();
  const firstEvent = result.events[0];
  const span = RUN_SPAN.start({
    "harness.run.id": Id.parse("00000000000000000000000000"),
    "harness.segment.id": Id.parse("11111111111111111111111111"),
  });
  const link = { context: span.spanContext() };

  expect(result.status).toBe("completed");
  expect(firstEvent?.traceId).toMatch(/^[0-9a-f]{32}$/u);
  expect(firstEvent?.spanId).toMatch(/^[0-9a-f]{16}$/u);
  expect(span.isRecording()).toBe(true);
  span
    .setAttribute("harness.run.id", "00000000000000000000000000")
    .setAttributes({ "harness.run.id": "00000000000000000000000000" })
    .addEvent("runtime_test")
    .addLink(link)
    .addLinks([link])
    .setStatus({ code: SpanStatusCode.OK })
    .updateName("harness.runtime_test");
  span.recordException(new Error("synthetic"));
  span.end();
  expect(span.isRecording()).toBe(false);
  expect(() => trace.getTracer("test").startActiveSpan("test", () => undefined)).toThrow();

  const noModel = await createRuntime(
    { run: RunConfigSchema.parse({}) },
    { store: new InMemoryEventStore() },
  );
  const failed = await noModel.run("goal");
  await noModel.close();
  expect(failed.status).toBe("failed");

  const bound = otelContext.bind(otelContext.active(), () => "bound");
  expect(bound()).toBe("bound");
  otelContext.disable();
});
