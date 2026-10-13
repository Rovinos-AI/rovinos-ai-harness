// SPDX-License-Identifier: Apache-2.0
import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { Code, type Event, type ModelRef } from "@harness/schemas";
import { ContextResultSchema, type ContextStrategy } from "../types.js";
import { NaiveStrategy } from "./naive.js";
import { SlidingWindowStrategy } from "./sliding-window.js";
import { SummarizingStrategy } from "./summarizing.js";
import { z } from "zod";

const goldenPath = new URL("../__golden__/strategy-output.json", import.meta.url);
const model: ModelRef = { provider: "test", model: "golden" };
const events: Event[] = [
  {
    runId: "00000000000000000000000000",
    seq: 0,
    ts: 0,
    v: 1,
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
    segmentId: "11111111111111111111111111",
    type: "run_input",
    input: "synthetic goal",
    inputKind: "initial",
  },
  ...(["first", "middle", "latest"] as const).map((text, index) => ({
    runId: "00000000000000000000000000",
    seq: index + 1,
    ts: index + 1,
    v: 1 as const,
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
    segmentId: "11111111111111111111111111",
    type: "model_response" as const,
    requestId: "22222222222222222222222222",
    provider: "test",
    model: "golden",
    inputTokens: 1,
    outputTokens: 1,
    finishReason: "stop" as const,
    latencyMs: 0,
    schemaValid: true,
    repairAttempts: 0,
    fallbackDepth: 0,
    content: [{ type: "text" as const, text }],
    providerBlobs: null,
  })),
];
const input = {
  events,
  budget: { maxTokens: 3, reserveOutputTokens: 0 },
  model,
  counter: { count: (messages: readonly unknown[]) => messages.length },
};

const StrategyGoldenSchema = z
  .record(
    z.string(),
    z
      .object({
        version: Code,
        output: ContextResultSchema,
      })
      .strict(),
  );

function strategies(): ContextStrategy[] {
  return [
    new NaiveStrategy(),
    new SlidingWindowStrategy(),
    new SummarizingStrategy(model),
  ];
}

async function loadGoldens() {
  const contents = await readFile(goldenPath, "utf8");
  const parsed: unknown = JSON.parse(contents);
  return StrategyGoldenSchema.parse(parsed);
}

async function assertMatchesGolden(strategy: ContextStrategy): Promise<void> {
  const expected = (await loadGoldens())[strategy.id];
  expect(expected).toBeDefined();
  expect(strategy.version).toBe(expected?.version);
  expect(await strategy.build(input)).toEqual(expected?.output);
}

describe("context strategy output version guards", () => {
  it("keeps a versioned golden output for every built-in strategy", async () => {
    if (process.env.UPDATE_GOLDEN === "1") {
      const output: Record<string, { version: string; output: unknown }> = {};
      for (const strategy of strategies()) {
        output[strategy.id] = {
          version: strategy.version,
          output: await strategy.build(input),
        };
      }
      await writeFile(goldenPath, `${JSON.stringify(output, null, 2)}\n`);
    }

    for (const strategy of strategies()) {
      await assertMatchesGolden(strategy);
    }
  });

  it("rejects changed output when a strategy version was not bumped", async () => {
    const strategy = new NaiveStrategy();
    const changed: ContextStrategy = {
      id: strategy.id,
      version: strategy.version,
      build: async (buildInput) => {
        const result = await strategy.build(buildInput);
        return ContextResultSchema.parse({
          ...result,
          messages: [
            ...result.messages,
            { role: "user", parts: [{ type: "text", text: "changed output" }] },
          ],
        });
      },
    };

    await expect(assertMatchesGolden(changed)).rejects.toThrow();
  });
});
