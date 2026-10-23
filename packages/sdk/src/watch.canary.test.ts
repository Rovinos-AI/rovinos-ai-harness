// SPDX-License-Identifier: Apache-2.0
import type { ModelPort } from "@harness/core";
import { HarnessConfigSchema } from "@harness/config";
import { InMemoryEventStore } from "@harness/store";
import { Code, FakeClock, SequentialIdGenerator } from "@harness/schemas";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness } from "./index.js";
import type { Harness } from "./types.js";

const contentCanary = "SDK_WATCH_CONTENT_CANARY_9421";
const harnesses: Harness[] = [];

async function waitForCompletion(harness: Harness, runId: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await harness.getRun(runId)).status === "completed") {
        return;
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }
  throw new Error("Run did not complete.");
}

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.close()));
});

describe("SDK safe-event canary", () => {
  it("never exposes input content through watch", async () => {
    const model: ModelPort = {
      complete: () =>
        Promise.resolve({
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
        }),
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
    const { runId } = await harness.startRun({ goal: contentCanary });
    await waitForCompletion(harness, runId);

    const watched: unknown[] = [];
    for await (const event of harness.watch(runId, { fromSeq: 0 })) {
      watched.push(event);
    }

    expect(watched.length).toBeGreaterThan(0);
    const sequences = watched.map((event) => event.seq);
    expect(sequences).toEqual([...sequences].sort((left, right) => left - right));
    expect(JSON.stringify(watched)).not.toContain(contentCanary);
    expect(JSON.stringify(watched)).not.toContain("run_input");
  });
});
