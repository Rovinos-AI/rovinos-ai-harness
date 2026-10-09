// SPDX-License-Identifier: Apache-2.0
import { RunConfigSchema } from "@harness/schemas";
import { InMemoryEventStore } from "@harness/store";
import { expect, it } from "vitest";
import { createRuntime } from "./runtime.js";
import { FakeModelPort } from "./testing/fake-model.js";

it("records valid span context when no OpenTelemetry provider is configured", async () => {
  const runtime = await createRuntime({ run: RunConfigSchema.parse({}) }, {
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
  });

  const result = await runtime.run("goal");
  await runtime.close();
  const firstEvent = result.events[0];

  expect(result.status).toBe("completed");
  expect(firstEvent?.traceId).toMatch(/^[0-9a-f]{32}$/u);
  expect(firstEvent?.spanId).toMatch(/^[0-9a-f]{16}$/u);
});
