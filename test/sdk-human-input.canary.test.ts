// SPDX-License-Identifier: Apache-2.0
import { context, logs, trace } from "@opentelemetry/api";
import { createRuntime, type PolicyPort } from "@rovinos/core";
import { FakeModelPort } from "@rovinos/core/testing";
import { createCanaries } from "@rovinos/eval";
import {
  Code,
  FakeClock,
  Id,
  PiiConfigSchema,
  Principal,
  RunConfigSchema,
  SequentialIdGenerator,
  type Event,
  type ModelCompletion,
} from "@rovinos/schemas";
import { InMemoryEventStore } from "@rovinos/store";
import { createTestContextManager } from "@rovinos/telemetry/testing";
import { createCanaryTelemetry } from "./canary/telemetry.js";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeVaultReader } from "./canary/runtime-fixture.js";

const traceId = "a".repeat(32);
const requestCallId = Id.parse("00000000000000000000000071");
const allowPolicy: PolicyPort = {
  version: Code.parse("synthetic.input.canary"),
  decide: () => ({
    decision: "allow",
    ruleId: Code.parse("synthetic.allow"),
    reason: Code.parse("synthetic_allowed"),
    editable: [],
  }),
};

function completion(parts: ModelCompletion["parts"]): ModelCompletion {
  return {
    parts,
    usage: { inputTokens: 1, outputTokens: 1 },
    finishReason: "stop",
    provider: Code.parse("synthetic"),
    model: Code.parse("input-canary"),
    latencyMs: 0,
    schemaValid: true,
    repairAttempts: 0,
    fallbackDepth: 0,
    providerBlobs: null,
  };
}

async function readEvents(
  store: InMemoryEventStore,
  runId: Id,
): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of store.read(runId)) {
    events.push(event);
  }
  return events;
}

describe("SDK human-input privacy canary", () => {
  afterEach(() => {
    trace.disable();
    logs.disable();
    context.disable();
  });

  it("keeps a raw SDK answer out of durable events and exported telemetry", async () => {
    const answer = createCanaries(randomUUID()).email.value;
    const reader = new RuntimeVaultReader();
    const telemetry = createCanaryTelemetry(reader);
    context.setGlobalContextManager(createTestContextManager());
    const store = new InMemoryEventStore();
    const runtime = await createRuntime(
      { run: RunConfigSchema.parse({}), pii: PiiConfigSchema.parse({}) },
      {
        store,
        model: new FakeModelPort([
          completion([
            {
              type: "tool_call",
              callId: requestCallId,
              toolId: Code.parse("agent.ask_user"),
              args: { question: "Provide the synthetic email address." },
            },
          ]),
          completion([{ type: "text", text: "The synthetic input was accepted." }]),
        ]),
        policy: allowPolicy,
        transientVault: true,
        clock: new FakeClock(1_000),
        ids: new SequentialIdGenerator(),
      },
    );
    reader.attach(runtime);
    try {
      const started = runtime.start("Collect a synthetic email address.");
      const suspended = await started.completion;
      const pending = suspended.state.pendingInputs.values().next().value;
      expect(suspended.status).toBe("suspended");
      expect(pending).toBeDefined();
      if (pending === undefined) {
        throw new Error("The runtime did not create its expected input request.");
      }

      await runtime.resolveInput(started.runId, pending.requestId, {
        action: "accept",
        answer,
        principal: Principal.parse("cli.canary"),
      });
      await runtime.resume(started.runId);
      await telemetry.sdk.forceFlush();

      const events = await readEvents(store, started.runId);
      const sinks = JSON.stringify({ events, spans: telemetry.spans, logs: telemetry.logs });
      expect(sinks).not.toContain(answer);
      expect(sinks).toContain("<EMAIL_1>");
    } finally {
      await runtime.close();
      await telemetry.sdk.forceFlush();
      telemetry.unsafeSpanCleanup();
      await Promise.all([
        telemetry.sdk.tracerProvider.shutdown(),
        telemetry.sdk.loggerProvider.shutdown(),
      ]);
    }
  });
});
