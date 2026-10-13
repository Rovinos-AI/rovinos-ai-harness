// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  ...(["compacted old", "older one", "older two"] as const).map((text, index) => ({
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
  {
    runId: "00000000000000000000000000",
    seq: 4,
    ts: 4,
    v: 1,
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
    segmentId: "11111111111111111111111111",
    type: "model_response",
    requestId: "22222222222222222222222222",
    provider: "test",
    model: "golden",
    inputTokens: 1,
    outputTokens: 1,
    finishReason: "tool_calls",
    latencyMs: 0,
    schemaValid: true,
    repairAttempts: 0,
    fallbackDepth: 0,
    content: [
      { type: "text", text: "tool step" },
      {
        type: "tool_call",
        callId: "33333333333333333333333333",
        toolId: "lookup",
        args: { query: "synthetic" },
      },
    ],
    providerBlobs: null,
  },
  {
    runId: "00000000000000000000000000",
    seq: 5,
    ts: 5,
    v: 1,
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
    segmentId: "11111111111111111111111111",
    type: "tool_result",
    callId: "33333333333333333333333333",
    toolId: "lookup",
    outcome: "ok",
    latencyMs: 0,
    result: { value: "synthetic result" },
  },
  {
    runId: "00000000000000000000000000",
    seq: 6,
    ts: 6,
    v: 1,
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
    segmentId: "11111111111111111111111111",
    type: "model_response",
    requestId: "22222222222222222222222222",
    provider: "test",
    model: "golden",
    inputTokens: 1,
    outputTokens: 1,
    finishReason: "stop",
    latencyMs: 0,
    schemaValid: true,
    repairAttempts: 0,
    fallbackDepth: 0,
    content: [{ type: "text", text: "latest" }],
    providerBlobs: null,
  },
  {
    runId: "00000000000000000000000000",
    seq: 7,
    ts: 7,
    v: 1,
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
    segmentId: "11111111111111111111111111",
    type: "context_compacted",
    fromSeq: 1,
    toSeq: 1,
    strategy: "summarizing",
    strategyVersion: "v1",
    summary: "summary of compacted work",
  },
];
const input = {
  events,
  budget: { maxTokens: 6, reserveOutputTokens: 0 },
  model,
  counter: { count: (messages: readonly unknown[]) => messages.length },
};

const StrategyGoldenSchema = z.record(
  z.string(),
  z
    .object({
      version: Code,
      output: ContextResultSchema,
    })
    .strict(),
);
const StoredStrategyGoldenSchema = z.record(
  z.string(),
  z
    .object({
      version: Code,
      output: z.unknown(),
    })
    .strict(),
);

function strategies(): ContextStrategy[] {
  return [new NaiveStrategy(), new SlidingWindowStrategy(), new SummarizingStrategy(model)];
}

async function loadGoldens(path: URL | string = goldenPath) {
  const contents = await readFile(path, "utf8");
  const parsed: unknown = JSON.parse(contents);
  return StrategyGoldenSchema.parse(parsed);
}

async function loadStoredGoldens(path: URL | string) {
  const contents = await readFile(path, "utf8");
  const parsed: unknown = JSON.parse(contents);
  return StoredStrategyGoldenSchema.parse(parsed);
}

class StrategyVersionBumpRequiredError extends Error {
  readonly code = "strategy_version_bump_required";
}

async function updateGoldens(
  path: URL | string,
  implementations: ContextStrategy[],
): Promise<void> {
  const previous = await loadStoredGoldens(path);
  const updated: Record<string, { version: string; output: unknown }> = {};
  for (const strategy of implementations) {
    const output = await strategy.build(input);
    const stored = previous[strategy.id];
    if (
      stored?.version === strategy.version &&
      JSON.stringify(stored.output) !== JSON.stringify(output)
    ) {
      throw new StrategyVersionBumpRequiredError();
    }
    updated[strategy.id] = { version: strategy.version, output };
  }
  const versionChangedOrNew = implementations.some(
    (strategy) => previous[strategy.id]?.version !== strategy.version,
  );
  if (versionChangedOrNew) {
    await writeFile(path, `${JSON.stringify(updated, null, 2)}\n`);
  }
}

async function assertMatchesGolden(strategy: ContextStrategy): Promise<void> {
  const expected = (await loadGoldens())[strategy.id];
  expect(expected).toBeDefined();
  expect(strategy.version).toBe(expected?.version);
  expect(await strategy.build(input)).toEqual(expected?.output);
}

describe("context strategy output version guards", () => {
  it("keeps a versioned golden output for every built-in strategy", async () => {
    expect(strategies()).toHaveLength(3);
    if (process.env.UPDATE_GOLDEN === "1") {
      await updateGoldens(goldenPath, strategies());
    }

    for (const strategy of strategies()) {
      await assertMatchesGolden(strategy);
    }
    const builtIns = strategies();
    const sliding = builtIns.find(({ id }) => id === "sliding_window");
    if (sliding === undefined) {
      throw new Error("Expected the sliding-window strategy.");
    }
    const slidingResult = await sliding.build(input);
    expect(slidingResult.stats.droppedGroups).toBeGreaterThan(0);
    expect(slidingResult.pinnedSeqs).toEqual([0, 1]);
    expect(slidingResult.messages.some(({ role }) => role === "tool")).toBe(true);
    expect(
      slidingResult.messages.some((message) =>
        message.parts.some((part) => part.type === "tool_call"),
      ),
    ).toBe(true);
    const summarizing = builtIns.find(({ id }) => id === "summarizing");
    if (summarizing === undefined) {
      throw new Error("Expected the summarizing strategy.");
    }
    const summarizedResult = await summarizing.build(input);
    expect(
      summarizedResult.messages.some((message) =>
        message.parts.some(
          (part) =>
            part.type === "text" &&
            part.text === "Summary of earlier work: summary of compacted work",
        ),
      ),
    ).toBe(true);
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

  it("refuses update mode output changes without a strategy version bump", async () => {
    const directory = await mkdtemp(join(tmpdir(), "context-strategy-golden-"));
    const path = join(directory, "golden.json");
    const original = await readFile(goldenPath, "utf8");
    await writeFile(path, original);
    try {
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
              { role: "user", parts: [{ type: "text", text: "changed" }] },
            ],
          });
        },
      };

      await expect(updateGoldens(path, [changed])).rejects.toMatchObject({
        code: "strategy_version_bump_required",
      });
      await expect(readFile(path, "utf8")).resolves.toBe(original);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
