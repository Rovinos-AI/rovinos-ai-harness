// SPDX-License-Identifier: Apache-2.0
import { randomBytes } from "node:crypto";
import { HarnessConfigSchema } from "@harness/config";
import type { ModelPort } from "@harness/core";
import { createHarness } from "@harness/sdk";
import { Code, FakeClock, Id } from "@harness/schemas";
import { PostgresEventStore } from "@harness/store";
import { expect, it } from "vitest";

const connectionString =
  process.env.TEST_POSTGRES_URL ?? "postgresql://harness@127.0.0.1:5432/harness";

function idsStartingAt(start: bigint) {
  let next = start;
  return {
    next: () => Id.parse((next++).toString().padStart(26, "0")),
  };
}

const fakeModel: ModelPort = {
  complete: () =>
    Promise.resolve({
      parts: [{ type: "text", text: "synthetic completion" }],
      usage: { inputTokens: 1, outputTokens: 1 },
      finishReason: "stop",
      provider: Code.parse("test"),
      model: Code.parse("test-model"),
      latencyMs: 0,
      schemaValid: true,
      repairAttempts: 0,
      fallbackDepth: 0,
      providerBlobs: null,
    }),
};

it("deduplicates concurrent starts across SDK instances using Postgres", async () => {
  const firstStore = new PostgresEventStore(connectionString);
  const secondStore = new PostgresEventStore(connectionString);
  const key = `sdk-idempotency-${randomBytes(16).toString("hex")}`;
  let firstHarness: Awaited<ReturnType<typeof createHarness>> | undefined;
  let secondHarness: Awaited<ReturnType<typeof createHarness>> | undefined;
  try {
    firstHarness = await createHarness({
      config: HarnessConfigSchema.parse({}),
      overrides: {
        store: firstStore,
        clock: new FakeClock(10_000),
        ids: idsStartingAt(1n),
        transientVault: true,
        model: fakeModel,
      },
    });
    secondHarness = await createHarness({
      config: HarnessConfigSchema.parse({}),
      overrides: {
        store: secondStore,
        clock: new FakeClock(10_000),
        ids: idsStartingAt(10_000n),
        transientVault: true,
        model: fakeModel,
      },
    });

    const [first, second] = await Promise.all([
      firstHarness.startRun({ goal: "Synthetic first request", idempotencyKey: key }),
      secondHarness.startRun({ goal: "Synthetic concurrent request", idempotencyKey: key }),
    ]);
    expect(first.runId).toBe(second.runId);
    const runs = await firstStore.listRuns({ limit: 100 });
    expect(runs.runs.filter(({ runId }) => runId === first.runId)).toHaveLength(1);
  } finally {
    await Promise.all([
      firstHarness?.close() ?? firstStore.close(),
      secondHarness?.close() ?? secondStore.close(),
    ]);
  }
});
