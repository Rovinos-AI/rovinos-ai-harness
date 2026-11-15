// SPDX-License-Identifier: Apache-2.0
import { context, trace, type Span } from "@opentelemetry/api";
import {
  Code,
  FakeClock,
  Id,
  SequentialIdGenerator,
  type Event,
} from "@rovinos/schemas";
import {
  InMemoryEventStore,
  InMemorySpendReservationStore,
  type EventStore,
} from "@rovinos/store";
import { createTestContextManager, createTestTracerProvider } from "@rovinos/telemetry/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ModelCompletion, ModelPort } from "../ports.js";
import { RunRecorder } from "../recorder.js";
import { MODEL_CALL_SPAN, RUN_SPAN } from "../spans.js";
import type { ModelStepOptions } from "./model-step.js";
import { recordModelFailure } from "./model-step-failure.js";

const runId = Id.parse("00000000000000000000000001");
const segmentId = Id.parse("00000000000000000000000002");
const quotaId = Code.parse("team");

beforeAll(() => {
  context.setGlobalContextManager(createTestContextManager());
  trace.setGlobalTracerProvider(createTestTracerProvider());
});

afterAll(() => {
  context.disable();
});

function completion(): ModelCompletion {
  return {
    parts: [{ type: "text", text: "invalid" }],
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cost: { version: 1, state: "known", amountMicros: 50 },
    },
    finishReason: "stop",
    provider: "test",
    model: "model",
    latencyMs: 1,
    schemaValid: false,
    repairAttempts: 1,
    fallbackDepth: 0,
    providerBlobs: null,
  };
}

function recorderFor(store: EventStore): RunRecorder {
  return new RunRecorder(store, runId, segmentId, 0, new FakeClock(1));
}

async function initialize(recorder: RunRecorder): Promise<void> {
  await recorder.withStepSpan(RUN_SPAN, {}, () =>
    recorder.record({
      type: "run_created",
      v: 1,
      configHash: "a".repeat(64),
      policyVersion: "test.policy",
    }),
  );
}

function options(recorder: RunRecorder, strict: boolean): ModelStepOptions {
  const model: ModelPort = {
    complete: vi.fn(() => Promise.resolve(completion())),
  };
  return {
    recorder,
    model,
    ids: new SequentialIdGenerator(),
    runId,
    messages: [],
    signal: new AbortController().signal,
    provider: Code.parse("test"),
    modelName: Code.parse("model"),
    outputSchema: z.string(),
    failureMode: "tool",
    contextMetadata: {
      strategyId: Code.parse("test"),
      strategyVersion: Code.parse("v1"),
      estimatedTokens: 10,
      messageCount: 0,
      stablePrefixMessages: 0,
    },
    ...(strict
      ? {
          usageUpdatesForCost: (cost) => [
            {
              quotaId,
              period: "day" as const,
              periodStart: 0,
              costMicros: cost.state === "unknown" ? 0 : cost.amountMicros,
              runsStarted: 0,
            },
          ],
        }
      : {}),
  };
}

async function events(store: EventStore): Promise<Event[]> {
  const recorded: Event[] = [];
  for await (const event of store.read(runId)) {
    recorded.push(event);
  }
  return recorded;
}

async function withFailureSpan(
  recorder: RunRecorder,
  run: (span: Span) => Promise<{ readonly event?: Event; readonly result: unknown }>,
): Promise<unknown> {
  let outcome: { readonly event?: Event; readonly result: unknown } | undefined;
  await recorder.withStepSpan(
    MODEL_CALL_SPAN,
    {
      "harness.context.strategy": Code.parse("test"),
      "harness.context.strategy_version": Code.parse("v1"),
      "harness.context.estimated_tokens": 0,
      "harness.context.message_count": 0,
      "harness.tool.definition_count": 0,
      "harness.tool.definition_bytes": 0,
    },
    async (span) => {
      outcome = await run(span);
      return outcome.event ?? runCreatedEvent();
    },
  );
  return outcome?.result;
}

function runCreatedEvent(): Event {
  return {
    runId,
    segmentId,
    seq: 0,
    ts: 1,
    v: 1,
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
    type: "run_created",
    configHash: "a".repeat(64),
    policyVersion: "test.policy",
    depth: 0,
  };
}

describe("recordModelFailure", () => {
  it("uses safe fallback codes and omits the terminal event in tool failure mode", async () => {
    const store = new InMemoryEventStore();
    const recorder = recorderFor(store);
    await initialize(recorder);
    const result = await withFailureSpan(recorder, async (span) =>
      recordModelFailure({
        options: options(recorder, false),
        requestId: Id.parse("00000000000000000000000003"),
        error: Object.assign(new Error("provider details are not recorded"), {
          code: "model_output_invalid",
        }),
        span,
        recorded: [],
        strictSpendActive: false,
      }),
    );

    expect(result).toMatchObject({ outcome: "failed", code: "result_invalid" });
    expect((await events(store)).map(({ type }) => type)).toEqual(["run_created"]);
  });

  it("records complete usage for invalid model output and settles its strict reservation", async () => {
    const store = new InMemorySpendReservationStore();
    const recorder = recorderFor(store);
    await initialize(recorder);
    const requestId = Id.parse("00000000000000000000000003");

    const result = await withFailureSpan(recorder, async (span) => {
      await recorder.reserveSpend(
        {
          runId,
          attemptId: requestId,
          quotaPeriods: [
            { quotaId, period: "day", periodStart: 0, limitMicros: 1_000 },
          ],
          estimatedMicros: 100,
          pricingRevision: Code.parse("prices.v1"),
        },
        {
          type: "model_request",
          v: 3,
          requestId,
          provider: "test",
          model: "model",
          messages: [],
          advertisedToolIds: [],
          requestHash: "b".repeat(64),
          requestParametersHash: "c".repeat(64),
        },
      );
      await recorder.markSpendDispatching(requestId);
      return recordModelFailure({
        options: options(recorder, true),
        requestId,
        error: Object.assign(new Error("invalid output"), {
          code: "model_output_invalid",
          usage: completion().usage,
          latencyMs: 17,
          repairAttempts: 2,
        }),
        span,
        recorded: [],
        strictSpendActive: true,
      });
    });

    expect(result).toMatchObject({ outcome: "failed", code: "result_invalid" });
    expect((await events(store)).map(({ type }) => type)).toEqual([
      "run_created",
      "model_request",
      "model_response",
    ]);
    await expect(store.readUsageLedger(quotaId, "day", [0])).resolves.toMatchObject([
      { costMicros: 50 },
    ]);
  });

  it("marks incomplete failure usage uncertain and continues through safe failure handling", async () => {
    const store = new InMemorySpendReservationStore();
    const recorder = recorderFor(store);
    await initialize(recorder);
    const requestId = Id.parse("00000000000000000000000003");

    const result = await withFailureSpan(recorder, async (span) => {
      await recorder.reserveSpend(
        {
          runId,
          attemptId: requestId,
          quotaPeriods: [
            { quotaId, period: "day", periodStart: 0, limitMicros: 1_000 },
          ],
          estimatedMicros: 100,
          pricingRevision: Code.parse("prices.v1"),
        },
        {
          type: "model_request",
          v: 3,
          requestId,
          provider: "test",
          model: "model",
          messages: [],
          advertisedToolIds: [],
          requestHash: "b".repeat(64),
          requestParametersHash: "c".repeat(64),
        },
      );
      await recorder.markSpendDispatching(requestId);
      return recordModelFailure({
        options: options(recorder, true),
        requestId,
        error: Object.assign(new Error("invalid output"), {
          code: "model_output_invalid",
          usage: { inputTokens: 10, outputTokens: 5 },
        }),
        span,
        recorded: [],
        strictSpendActive: true,
      });
    });

    expect(result).toMatchObject({ outcome: "failed", code: "result_invalid" });
    expect((await events(store)).map(({ type }) => type)).toEqual([
      "run_created",
      "model_request",
      "model_response",
    ]);
    await expect(
      store.markSpendUncertain(requestId, "spend_reservation_usage_incomplete"),
    ).resolves.toMatchObject({ state: "uncertain" });
  });
});
