// SPDX-License-Identifier: Apache-2.0
import { context, trace } from "@opentelemetry/api";
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
import type { ModelCompletion, ModelPort } from "../ports.js";
import { RunRecorder } from "../recorder.js";
import { RUN_SPAN } from "../spans.js";
import type { ModelStepOptions } from "./model-step.js";
import { executeModelStep } from "./model-step-execution.js";

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
    parts: [{ type: "text", text: "done" }],
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cost: { version: 1, state: "known", amountMicros: 50 },
    },
    finishReason: "stop",
    provider: "test",
    model: "model",
    latencyMs: 1,
    schemaValid: true,
    repairAttempts: 0,
    fallbackDepth: 0,
    providerBlobs: null,
  };
}

async function setup(store: EventStore): Promise<RunRecorder> {
  const recorder = new RunRecorder(store, runId, segmentId, 0, new FakeClock(1));
  await recorder.withStepSpan(RUN_SPAN, {}, () =>
    recorder.record({
      type: "run_created",
      v: 1,
      configHash: "a".repeat(64),
      policyVersion: "test.policy",
    }),
  );
  return recorder;
}

function options(
  recorder: RunRecorder,
  model: ModelPort,
  strict: boolean,
  signal: AbortSignal = new AbortController().signal,
): ModelStepOptions {
  return {
    recorder,
    model,
    ids: new SequentialIdGenerator(),
    runId,
    messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }],
    signal,
    provider: Code.parse("test"),
    modelName: Code.parse("model"),
    contextMetadata: {
      strategyId: Code.parse("test"),
      strategyVersion: Code.parse("v1"),
      estimatedTokens: 10,
      messageCount: 1,
      stablePrefixMessages: 0,
    },
    ...(strict
      ? {
          strictSpendOptions: () => ({
            pricing: {
              "test/model": {
                inputMicrosPerMTok: 1_000_000,
                outputMicrosPerMTok: 1_000_000,
                maxInputTokens: 100,
                maxOutputTokens: 10,
              },
            },
            pricingRevision: Code.parse("prices.v1"),
            quotaPeriods: [
              {
                quotaId,
                period: "day" as const,
                periodStart: 0,
                limitMicros: 1_000,
              },
            ],
          }),
        }
      : {}),
    usageUpdatesForCost: (cost) => [
      {
        quotaId,
        period: "day",
        periodStart: 0,
        costMicros: cost.state === "unknown" ? 0 : cost.amountMicros,
        runsStarted: 0,
      },
    ],
  };
}

async function readEvents(store: EventStore): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of store.read(runId)) {
    events.push(event);
  }
  return events;
}

describe("executeModelStep", () => {
  it("uses the legacy request and response path when strict reservations are disabled", async () => {
    const store = new InMemoryEventStore();
    const recorder = await setup(store);
    const model: ModelPort = {
      complete: vi.fn(() => Promise.resolve(completion())),
    };

    const result = await executeModelStep(options(recorder, model, false));

    expect(result.outcome).toBe("response");
    expect((await readEvents(store)).map(({ type }) => type)).toEqual([
      "run_created",
      "model_request",
      "model_response",
    ]);
  });

  it("settles strict reservations atomically with the provider response", async () => {
    const store = new InMemorySpendReservationStore();
    const recorder = await setup(store);
    const complete = vi.fn<ModelPort["complete"]>().mockResolvedValue(completion());
    const model: ModelPort = { complete };

    const result = await executeModelStep(options(recorder, model, true));

    expect(result.outcome).toBe("response");
    expect(complete).toHaveBeenCalledOnce();
    expect((await readEvents(store)).map(({ type }) => type)).toEqual([
      "run_created",
      "model_request",
      "model_response",
    ]);
    await expect(store.readUsageLedger(quotaId, "day", [0])).resolves.toMatchObject([
      { costMicros: 50 },
    ]);
  });

  it("keeps a successful response with incomplete cost uncertain", async () => {
    const store = new InMemorySpendReservationStore();
    const recorder = await setup(store);
    const incomplete = {
      ...completion(),
      usage: { inputTokens: 10, outputTokens: 5 },
    };
    const model: ModelPort = {
      complete: vi.fn(() => Promise.resolve(incomplete)),
    };

    const result = await executeModelStep(options(recorder, model, true));

    expect(result.outcome).toBe("response");
    expect((await readEvents(store)).map(({ type }) => type)).toEqual([
      "run_created",
      "model_request",
      "model_response",
    ]);
    await expect(
      store.reserveSpend(
        {
          runId,
          attemptId: Id.parse("00000000000000000000000099"),
          quotaPeriods: [
            { quotaId, period: "day", periodStart: 0, limitMicros: 1_000 },
          ],
          estimatedMicros: 1,
          pricingRevision: Code.parse("prices.v1"),
        },
        {
          runId,
          ts: 1,
          traceId: "a".repeat(32),
          spanId: "b".repeat(16),
          segmentId,
          type: "model_request",
          v: 3,
          requestId: Id.parse("00000000000000000000000099"),
          provider: "test",
          model: "model",
          messages: [],
          advertisedToolIds: [],
          requestHash: "c".repeat(64),
          requestParametersHash: "d".repeat(64),
        },
        3,
      ),
    ).rejects.toMatchObject({ code: "spend_reservation_uncertain" });
  });

  it("retains uncertainty when atomic settlement fails after dispatch", async () => {
    const store = new InMemorySpendReservationStore();
    const recorder = await setup(store);
    const markUncertain = vi.spyOn(store, "markSpendUncertain");
    const settle = vi.spyOn(recorder, "settleSpend").mockRejectedValue(new Error("storage failure"));
    let requestId: Id | undefined;
    const model: ModelPort = {
      complete: vi.fn(async (request) => {
        requestId = request.requestId;
        return completion();
      }),
    };

    await expect(executeModelStep(options(recorder, model, true))).rejects.toThrow(
      "storage failure",
    );

    expect(settle).toHaveBeenCalledOnce();
    expect(markUncertain).toHaveBeenCalledOnce();
    expect(requestId).toBeDefined();
  });

  it("releases a reservation when cancellation occurs before dispatch", async () => {
    const store = new InMemorySpendReservationStore();
    const recorder = await setup(store);
    const controller = new AbortController();
    controller.abort();
    const complete = vi.fn<ModelPort["complete"]>().mockResolvedValue(completion());
    const model: ModelPort = { complete };

    await expect(executeModelStep(options(recorder, model, true, controller.signal))).rejects.toThrow();

    expect(complete).not.toHaveBeenCalled();
    expect((await readEvents(store)).map(({ type }) => type)).toEqual([
      "run_created",
      "model_request",
    ]);
  });
});
