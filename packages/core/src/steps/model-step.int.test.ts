// SPDX-License-Identifier: Apache-2.0
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ensureTracingFallback } from "@rovinos/telemetry";
import {
  Code,
  FakeClock,
  Id,
  RunConfigSchema,
  SequentialIdGenerator,
  type CostValue,
  type Event,
  type ModelRef,
} from "@rovinos/schemas";
import {
  InMemoryEventStore,
  InMemorySpendReservationStore,
  type EventStore,
  type UsageLedgerDelta,
} from "@rovinos/store";
import type { ModelCompletion, ModelPort } from "../ports.js";
import { RunRecorder } from "../recorder.js";
import type { StrictSpendCallOptions } from "../quotas.js";
import { RUN_SPAN } from "../spans.js";
import { modelStep, type ModelStepOptions } from "./model-step.js";

const runId = Id.parse("00000000000000000000000001");
const segmentId = Id.parse("00000000000000000000000002");
const quotaId = Code.parse("strict-spend-test");
const modelRef: ModelRef = { provider: Code.parse("test"), model: Code.parse("model") };
const ids = new SequentialIdGenerator();
const quotaPeriod = {
  quotaId,
  period: "day" as const,
  periodStart: 0,
  limitMicros: 1_000,
};

beforeAll(() => {
  ensureTracingFallback(
    RUN_SPAN.start({ "harness.run.id": runId, "harness.segment.id": segmentId }),
  );
});

function completion(costMicros = 50): ModelCompletion {
  return {
    parts: [{ type: "text", text: "done" }],
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cost: { version: 1, state: "known", amountMicros: costMicros },
    },
    finishReason: "stop",
    provider: modelRef.provider,
    model: modelRef.model,
    latencyMs: 1,
    schemaValid: true,
    repairAttempts: 0,
    fallbackDepth: 0,
    providerBlobs: null,
  };
}

function rate(ceilings = true) {
  return {
    inputMicrosPerMTok: 1_000_000,
    outputMicrosPerMTok: 1_000_000,
    ...(ceilings ? { maxInputTokens: 100, maxOutputTokens: 10 } : {}),
  };
}

async function setup(store: EventStore): Promise<RunRecorder> {
  const recorder = new RunRecorder(store, runId, segmentId, 0, new FakeClock(1));
  await recorder.withStepSpan(RUN_SPAN, {}, async () =>
    recorder.record({
      type: "run_created",
      v: 1,
      configHash: "a".repeat(64),
      policyVersion: "test.policy",
    }),
  );
  return recorder;
}

function strictOptions(
  pricing: StrictSpendCallOptions["pricing"] = {
    [`${modelRef.provider}/${modelRef.model}`]: rate(),
  },
  quotaPeriods = [quotaPeriod],
  pricingRevision: string | null = "prices.v1",
): NonNullable<ModelStepOptions["strictSpendOptions"]> {
  return () => ({
    pricing,
    ...(pricingRevision === null ? {} : { pricingRevision: Code.parse(pricingRevision) }),
    quotaPeriods,
  });
}

function stepOptions(
  recorder: RunRecorder,
  model: ModelPort,
  strict: ModelStepOptions["strictSpendOptions"] | null = strictOptions(),
  overrides: Partial<ModelStepOptions> = {},
): ModelStepOptions {
  return {
    recorder,
    model,
    ids,
    runId,
    messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }],
    signal: new AbortController().signal,
    provider: modelRef.provider,
    modelName: modelRef.model,
    contextMetadata: {
      strategyId: Code.parse("test"),
      strategyVersion: Code.parse("v1"),
      estimatedTokens: 10,
      messageCount: 1,
      stablePrefixMessages: 0,
    },
    ...(strict === undefined || strict === null ? {} : { strictSpendOptions: strict }),
    usageUpdatesForCost: (cost: CostValue): readonly UsageLedgerDelta[] => [
      {
        quotaId,
        period: "day",
        periodStart: 0,
        costMicros: cost.state === "unknown" ? 0 : cost.amountMicros,
        ...(cost.state === "unknown" || cost.state === "partial" ? { unknownCostCount: 1 } : {}),
        runsStarted: 0,
      },
    ],
    ...overrides,
  };
}

async function readEvents(store: EventStore): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of store.read(runId)) {
    events.push(event);
  }
  return events;
}

describe("modelStep strict spend reservations", () => {
  it("rejects every missing admission input and unavailable storage before dispatch", async () => {
    const cases: {
      readonly name: string;
      readonly store: EventStore;
      readonly strict: ModelStepOptions["strictSpendOptions"];
      readonly code: string;
    }[] = [
      {
        name: "missing pricing revision",
        store: new InMemorySpendReservationStore(),
        strict: strictOptions(undefined, undefined, null),
        code: "spend_reservation_pricing_missing",
      },
      {
        name: "missing model price",
        store: new InMemorySpendReservationStore(),
        strict: strictOptions({}, [quotaPeriod]),
        code: "spend_reservation_pricing_missing",
      },
      {
        name: "missing token ceilings",
        store: new InMemorySpendReservationStore(),
        strict: strictOptions({ [`${modelRef.provider}/${modelRef.model}`]: rate(false) }),
        code: "spend_reservation_estimate_missing",
      },
      {
        name: "input estimate beyond the configured ceiling",
        store: new InMemorySpendReservationStore(),
        strict: strictOptions(),
        code: "spend_reservation_estimate_missing",
      },
      {
        name: "estimate exceeds the safe integer range",
        store: new InMemorySpendReservationStore(),
        strict: strictOptions(
          {
            [`${modelRef.provider}/${modelRef.model}`]: {
              inputMicrosPerMTok: Number.MAX_SAFE_INTEGER,
              outputMicrosPerMTok: Number.MAX_SAFE_INTEGER,
              maxInputTokens: Number.MAX_SAFE_INTEGER,
              maxOutputTokens: Number.MAX_SAFE_INTEGER,
            },
          },
        ),
        code: "spend_reservation_estimate_missing",
      },
      {
        name: "quota estimate exceeds the configured limit",
        store: new InMemorySpendReservationStore(),
        strict: strictOptions(undefined, [{ ...quotaPeriod, limitMicros: 10 }]),
        code: "spend_reservation_quota_exceeded",
      },
      {
        name: "transactional reservation store unavailable",
        store: new InMemoryEventStore(),
        strict: strictOptions(),
        code: "spend_reservation_storage_unavailable",
      },
    ];

    for (const testCase of cases) {
      const store = testCase.store;
      const recorder = await setup(store);
      const model: ModelPort = { complete: vi.fn(() => Promise.resolve(completion())) };
      const overrides =
        testCase.name === "input estimate beyond the configured ceiling"
          ? {
              contextMetadata: {
                strategyId: Code.parse("test"),
                strategyVersion: Code.parse("v1"),
                estimatedTokens: 101,
                messageCount: 1,
                stablePrefixMessages: 0,
              },
            }
          : {};
      await expect(
        modelStep(stepOptions(recorder, model, testCase.strict, overrides)),
        testCase.name,
      ).rejects.toMatchObject({ code: testCase.code });
      expect(model.complete, testCase.name).not.toHaveBeenCalled();
      expect((await readEvents(store)).map(({ type }) => type), testCase.name).toEqual([
        "run_created",
      ]);
    }

    expect(RunConfigSchema.parse({}).strictSpendReservations).toBeUndefined();
  });

  it("persists the request and dispatching transition before provider invocation, then settles usage", async () => {
    const store = new InMemorySpendReservationStore();
    const recorder = await setup(store);
    const markDispatching = vi.spyOn(store, "markSpendDispatching");
    const model: ModelPort = {
      complete: vi.fn(async (request) => {
        expect((await readEvents(store)).some((event) => event.type === "model_request")).toBe(true);
        expect(markDispatching).toHaveBeenCalledWith(request.requestId);
        return completion();
      }),
    };

    const result = await modelStep(stepOptions(recorder, model));
    expect(result.outcome).toBe("response");
    expect(markDispatching).toHaveBeenCalledOnce();
    expect((await store.readUsageLedger(quotaId, "day", [0]))[0]?.costMicros).toBe(50);
    expect((await readEvents(store)).map(({ type }) => type)).toEqual([
      "run_created",
      "model_request",
      "model_response",
    ]);
  });

  it("records an overrun and rejects a later call before dispatch", async () => {
    const store = new InMemorySpendReservationStore();
    const recorder = await setup(store);
    const cheapRate = {
      [`${modelRef.provider}/${modelRef.model}`]: {
        inputMicrosPerMTok: 0,
        outputMicrosPerMTok: 0,
        maxInputTokens: 100,
        maxOutputTokens: 10,
      },
    };
    const firstModel: ModelPort = {
      complete: vi.fn(() => Promise.resolve(completion(1_100))),
    };
    await modelStep(stepOptions(recorder, firstModel, strictOptions(cheapRate)));
    const laterModel: ModelPort = { complete: vi.fn(() => Promise.resolve(completion())) };
    await expect(modelStep(stepOptions(recorder, laterModel))).rejects.toMatchObject({
      code: "spend_reservation_quota_exceeded",
    });
    expect(laterModel.complete).not.toHaveBeenCalled();
    expect((await store.readUsageLedger(quotaId, "day", [0]))[0]?.costMicros).toBe(1_100);
  });

  it("keeps a failed dispatched attempt uncertain and uses a fresh key for a later-period retry", async () => {
    const store = new InMemorySpendReservationStore();
    const recorder = await setup(store);
    const failedModel: ModelPort = {
      complete: vi.fn(() => Promise.reject(Object.assign(new Error("provider lost"), {
        code: "provider_timeout",
      }))),
    };
    const first = await modelStep(stepOptions(recorder, failedModel));
    expect(first.outcome).toBe("failed");

    const blockedModel: ModelPort = { complete: vi.fn(() => Promise.resolve(completion())) };
    await expect(modelStep(stepOptions(recorder, blockedModel))).rejects.toMatchObject({
      code: "spend_reservation_uncertain",
    });
    expect(blockedModel.complete).not.toHaveBeenCalled();

    const nextPeriod = [{ ...quotaPeriod, periodStart: 86_400_000 }];
    const retryModel: ModelPort = { complete: vi.fn(() => Promise.resolve(completion())) };
    const retry = await modelStep(
      stepOptions(recorder, retryModel, strictOptions(undefined, nextPeriod), {
        usageUpdatesForCost: (cost) => [
          {
            quotaId,
            period: "day",
            periodStart: 86_400_000,
            costMicros: cost.state === "unknown" ? 0 : cost.amountMicros,
            runsStarted: 0,
          },
        ],
      }),
    );
    expect(retry.outcome).toBe("response");
    const requestIds = (await readEvents(store))
      .filter((event) => event.type === "model_request")
      .map((event) => event.requestId);
    expect(requestIds).toHaveLength(2);
    expect(requestIds[0]).not.toBe(requestIds[1]);
  });

  it("keeps an incomplete-cost response uncertain and blocks another call in the same period", async () => {
    const store = new InMemorySpendReservationStore();
    const recorder = await setup(store);
    const incompleteModel: ModelPort = {
      complete: vi.fn(() =>
        Promise.resolve({
          ...completion(),
          usage: { inputTokens: 10, outputTokens: 5 },
        }),
      ),
    };
    const result = await modelStep(stepOptions(recorder, incompleteModel));
    expect(result.outcome).toBe("response");

    const laterModel: ModelPort = { complete: vi.fn(() => Promise.resolve(completion())) };
    await expect(modelStep(stepOptions(recorder, laterModel))).rejects.toMatchObject({
      code: "spend_reservation_uncertain",
    });
    expect(laterModel.complete).not.toHaveBeenCalled();
  });

  it("does not reserve when strict mode is omitted", async () => {
    const store = new InMemoryEventStore();
    const recorder = await setup(store);
    const model: ModelPort = { complete: vi.fn(() => Promise.resolve(completion())) };

    const result = await modelStep(stepOptions(recorder, model, null));

    expect(result.outcome).toBe("response");
    expect((await readEvents(store)).map(({ type }) => type)).toEqual([
      "run_created",
      "model_request",
      "model_response",
    ]);
  });
});
