// SPDX-License-Identifier: Apache-2.0
import { FakeClock, Id, Code } from "@rovinos/schemas";
import { InMemorySpendReservationStore } from "@rovinos/store";
import { describe, expect, it, vi } from "vitest";
import { RunRecorder } from "../recorder.js";
import type { ModelPort } from "../ports.js";
import type { ModelStepOptions } from "./model-step.js";
import { markUncertain, prepareSpendReservation } from "./model-step-reservation.js";

const runId = Id.parse("00000000000000000000000001");
const segmentId = Id.parse("00000000000000000000000002");
const attemptId = Id.parse("00000000000000000000000003");
const quotaId = Code.parse("team");

function options(
  strictSpendOptions: ModelStepOptions["strictSpendOptions"] | undefined,
): ModelStepOptions {
  const recorder = new RunRecorder(
    new InMemorySpendReservationStore(),
    runId,
    segmentId,
    0,
    new FakeClock(1),
  );
  const model: ModelPort = {
    complete: () => Promise.reject(new Error("not used")),
  };
  return {
    recorder,
    model,
    ids: { next: () => attemptId },
    runId,
    messages: [],
    signal: new AbortController().signal,
    provider: Code.parse("test"),
    modelName: Code.parse("model"),
    contextMetadata: {
      strategyId: Code.parse("test"),
      strategyVersion: Code.parse("v1"),
      estimatedTokens: 10,
      messageCount: 0,
      stablePrefixMessages: 0,
    },
    ...(strictSpendOptions === undefined ? {} : { strictSpendOptions }),
  };
}

describe("model-step reservation helpers", () => {
  it("skips reservation when strict mode or matching quota periods are absent", () => {
    expect(prepareSpendReservation(options(undefined), attemptId)).toBeUndefined();
    expect(
      prepareSpendReservation(
        options(() => ({
          pricingRevision: Code.parse("prices.v1"),
          pricing: {},
          quotaPeriods: [],
        })),
        attemptId,
      ),
    ).toBeUndefined();
  });

  it("rejects missing pricing revision or a price for the selected model", () => {
    const quotaPeriods = [{ quotaId, period: "day" as const, periodStart: 0, limitMicros: 100 }];
    expect(() =>
      prepareSpendReservation(
        options(() => ({ pricing: {}, quotaPeriods })),
        attemptId,
      ),
    ).toThrow(expect.objectContaining({ code: "spend_reservation_pricing_missing" }));
    expect(() =>
      prepareSpendReservation(
        options(() => ({
          pricing: {},
          pricingRevision: Code.parse("prices.v1"),
          quotaPeriods,
        })),
        attemptId,
      ),
    ).toThrow(expect.objectContaining({ code: "spend_reservation_pricing_missing" }));
  });

  it("builds a bounded reservation from the configured model price", () => {
    const quotaPeriods = [{ quotaId, period: "day" as const, periodStart: 0, limitMicros: 100 }];
    const prepared = prepareSpendReservation(
      options(() => ({
        pricing: {
          "test/model": {
            inputMicrosPerMTok: 100,
            outputMicrosPerMTok: 200,
            maxInputTokens: 10_000,
            maxOutputTokens: 1_000,
          },
        },
        pricingRevision: Code.parse("prices.v1"),
        quotaPeriods,
      })),
      attemptId,
    );

    expect(prepared).toEqual({
      input: {
        runId,
        attemptId,
        quotaPeriods,
        estimatedMicros: 2,
        pricingRevision: "prices.v1",
      },
      maxOutputTokens: 1_000,
    });
  });

  it("forwards uncertainty transitions to the recorder", async () => {
    const recorder = options(undefined).recorder;
    const markSpendUncertain = vi
      .spyOn(recorder, "markSpendUncertain")
      .mockResolvedValue(undefined);

    await markUncertain(recorder, attemptId, "spend_reservation_uncertain");

    expect(markSpendUncertain).toHaveBeenCalledWith(attemptId, "spend_reservation_uncertain");
  });
});
