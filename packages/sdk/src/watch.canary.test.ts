// SPDX-License-Identifier: Apache-2.0
import type { ModelPort } from "@rovinos/core";
import { HarnessConfigSchema } from "@rovinos/config";
import { InMemoryEventStore } from "@rovinos/store";
import { Code, FakeClock, SequentialIdGenerator } from "@rovinos/schemas";
import type { SafeEvent } from "@rovinos/telemetry";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness } from "./index.js";
import type { Harness } from "./types.js";

const contentCanary = "SDK_WATCH_CONTENT_CANARY_9421";
const harnesses: Harness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.close()));
});

describe("SDK safe-event canary", () => {
  it("streams ordered, content-free safe events while a run is active", async () => {
    let notifyModelStarted: (() => void) | undefined;
    const modelStarted = new Promise<void>((resolve) => {
      notifyModelStarted = resolve;
    });
    let releaseModel: (() => void) | undefined;
    const modelGate = new Promise<void>((resolve) => {
      releaseModel = resolve;
    });
    const model: ModelPort = {
      complete: async () => {
        notifyModelStarted?.();
        await modelGate;
        return {
          parts: [{ type: "text", text: "Synthetic completion" }],
          usage: { inputTokens: 1, outputTokens: 1 },
          finishReason: "stop",
          provider: Code.parse("test"),
          model: Code.parse("canary"),
          latencyMs: 0,
          schemaValid: true,
          repairAttempts: 0,
          fallbackDepth: 0,
          providerBlobs: null,
        };
      },
    };
    const harness = await createHarness({
      config: HarnessConfigSchema.parse({}),
      overrides: {
        store: new InMemoryEventStore(),
        clock: new FakeClock(20_000),
        ids: new SequentialIdGenerator(),
        transientVault: true,
        model,
      },
    });
    harnesses.push(harness);
    try {
      const { runId } = await harness.startRun({ goal: contentCanary });
      await modelStarted;

      const watched: SafeEvent[] = [];
      const iterator = harness.watch(runId, { fromSeq: 0 })[Symbol.asyncIterator]();
      let runningStatusSeen = false;
      while (!runningStatusSeen) {
        const next = await iterator.next();
        if (next.done === true) {
          break;
        }
        watched.push(next.value);
        runningStatusSeen = next.value.kind === "run_status" && next.value.to === "running";
      }

      expect(runningStatusSeen).toBe(true);
      expect((await harness.getRun(runId)).status).toBe("running");
      releaseModel?.();

      let watchComplete = false;
      while (!watchComplete) {
        const next = await iterator.next();
        if (next.done === true) {
          watchComplete = true;
        } else {
          watched.push(next.value);
        }
      }

      expect(watched.length).toBeGreaterThan(0);
      const sequences = watched.map((event) => event.seq);
      expect(sequences).toEqual([...sequences].sort((left, right) => left - right));
      expect(JSON.stringify(watched)).not.toContain(contentCanary);
      expect(JSON.stringify(watched)).not.toContain("run_input");
    } finally {
      releaseModel?.();
    }
  });
});
