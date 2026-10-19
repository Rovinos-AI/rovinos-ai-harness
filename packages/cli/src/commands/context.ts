// SPDX-License-Identifier: Apache-2.0
// Offline inspection uses heuristic estimates and never initializes a provider-backed model.
import {
  ContextInspectionSchema,
  HarnessError,
  Id,
  ModelRefSchema,
  type Event,
  type ModelRef,
} from "@harness/schemas";
import type { ContextBudget, ContextResult, ContextStrategy } from "@harness/context";
import { InvalidArgumentError } from "commander";
import { z } from "zod";
import { createCommandRuntime, type CliContext, type CommandModule } from "../command.js";

const OptionsSchema = z
  .object({
    strategy: z.string(),
    maxTokens: z.number().int().nonnegative(),
    reserveOutput: z.number().int().nonnegative(),
    model: z.string().optional(),
    showContent: z.boolean().optional(),
    compare: z.string().optional(),
  })
  .strict();

class ContextCommandError extends HarnessError {
  constructor(readonly code: "usage" | "run_not_found" | "context_model_call_forbidden") {
    super(code);
  }
}

function tokenCount(value: string): number {
  if (!/^\d+$/u.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new InvalidArgumentError("usage");
  }
  return Number(value);
}

function modelReference(value: string | undefined, fallback: ModelRef): ModelRef {
  const parts = value?.split("/");
  const result = ModelRefSchema.safeParse(
    parts === undefined ? fallback : { provider: parts[0], model: parts[1] },
  );
  if (!result.success || (parts !== undefined && parts.length !== 2)) {
    throw new ContextCommandError("usage");
  }
  return result.data;
}

async function inspection(input: {
  runId: string;
  events: readonly Event[];
  strategy: ContextStrategy;
  model: ModelRef;
  budget: ContextBudget;
  built: ContextResult;
  showContent: boolean;
}) {
  const { runId, events, strategy, model, budget, built, showContent } = input;
  const { eventsToTranscript, OffloadedStub } = await import("@harness/context");
  const groupCount = eventsToTranscript(events).length;
  return ContextInspectionSchema.parse({
    runId,
    strategy: strategy.id,
    strategyVersion: strategy.version,
    model,
    ...budget,
    messageCount: built.stats.messageCount,
    estimatedTokens: built.stats.estimatedTokens,
    groupCount,
    retainedGroups: groupCount - built.stats.droppedGroups,
    droppedGroups: built.stats.droppedGroups,
    compactedRanges: events
      .filter((event) => event.type === "context_compacted")
      .map(({ fromSeq, toSeq }) => ({ fromSeq, toSeq })),
    offloadedHandles: built.messages.flatMap((message) =>
      message.parts.flatMap((part) => {
        if (part.type !== "tool_result") {
          return [];
        }
        const stub = OffloadedStub.safeParse(part.result);
        return stub.success
          ? [{ handle: stub.data.$offloaded.handle, bytes: stub.data.$offloaded.bytes }]
          : [];
      }),
    ),
    pinnedSeqs: built.pinnedSeqs,
    ...(showContent ? { messages: built.messages } : {}),
  });
}

function humanSummary(result: Awaited<ReturnType<typeof inspection>>): string {
  const compactedRanges =
    result.compactedRanges.length === 0
      ? "none"
      : result.compactedRanges
          .map(({ fromSeq, toSeq }) => `${String(fromSeq)}-${String(toSeq)}`)
          .join(", ");
  const offloadedHandles =
    result.offloadedHandles.length === 0
      ? "none"
      : result.offloadedHandles
          .map(({ handle, bytes }) => `${handle} (${String(bytes)} bytes)`)
          .join(", ");
  const pinnedSeqs = result.pinnedSeqs.length === 0 ? "none" : result.pinnedSeqs.join(", ");
  const availableTokens = Math.max(0, result.maxTokens - result.reserveOutputTokens);
  return [
    `Strategy: ${result.strategy} ${result.strategyVersion}`,
    `Messages: ${String(result.messageCount)}`,
    `Estimated tokens: ${String(result.estimatedTokens)} / ${String(availableTokens)} available (max ${String(result.maxTokens)}, reserve ${String(result.reserveOutputTokens)})`,
    `Groups: ${String(result.retainedGroups)} retained, ${String(result.droppedGroups)} dropped`,
    `Compacted ranges: ${compactedRanges}`,
    `Offloaded handles: ${offloadedHandles}`,
    `Pinned sequences: ${pinnedSeqs}`,
    ...(result.messages === undefined
      ? []
      : ["Messages content:", JSON.stringify(result.messages, null, 2)]),
    "",
  ].join("\n");
}

function selectedStrategyNames(
  options: z.infer<typeof OptionsSchema>,
  registry: ReadonlyMap<string, ContextStrategy>,
  context: CliContext,
): string[] {
  const names =
    options.compare === undefined
      ? [options.strategy]
      : options.compare.split(",").map((name) => name.trim());
  if (options.compare !== undefined && (names.length !== 2 || new Set(names).size !== 2)) {
    throw new ContextCommandError("usage");
  }
  if (names.some((name) => !registry.has(name))) {
    context.out.error("available_strategies");
    for (const name of registry.keys()) {
      context.out.error(name);
    }
    throw new ContextCommandError("usage");
  }
  return names;
}

async function comparisonReport(input: {
  events: readonly Event[];
  strategies: readonly ContextStrategy[];
  model: ModelRef;
  budget: ContextBudget;
}) {
  const { compareStrategies, coverage, HeuristicTokenCounter, StrategyComparisonReportSchema } =
    await import("@harness/context");
  const comparisons = await compareStrategies(input.events, input.strategies, {
    budget: input.budget,
    model: input.model,
    counter: new HeuristicTokenCounter(),
  });
  const first = comparisons[0];
  const second = comparisons[1];
  if (first === undefined || second === undefined) {
    throw new ContextCommandError("usage");
  }
  return StrategyComparisonReportSchema.parse({
    comparisons,
    coverage: [
      {
        strategy: first.strategy,
        comparedTo: second.strategy,
        retainedSeqCoverage: coverage(first, second),
      },
      {
        strategy: second.strategy,
        comparedTo: first.strategy,
        retainedSeqCoverage: coverage(second, first),
      },
    ],
  });
}

function comparisonTableRows(report: Awaited<ReturnType<typeof comparisonReport>>) {
  return [
    [
      "Strategy",
      "Version",
      "Tokens",
      "Messages",
      "Dropped",
      "Compacted ranges",
      "Retained refs",
      "Coverage",
    ],
    ...report.comparisons.map((comparison, index) => {
      const ranges = comparison.compactedRanges
        .map(({ fromSeq, toSeq }) => `${String(fromSeq)}-${String(toSeq)}`)
        .join(", ");
      const retainedSeqs = comparison.retainedSeqs
        .map(({ runId, seq }) => `${runId}:${String(seq)}`)
        .join(", ");
      const retainedSeqCoverage = report.coverage[index]?.retainedSeqCoverage ?? 0;
      return [
        comparison.strategy,
        comparison.strategyVersion,
        comparison.estimatedTokens,
        comparison.messageCount,
        comparison.droppedGroups,
        ranges.length === 0 ? "none" : ranges,
        retainedSeqs.length === 0 ? "none" : retainedSeqs,
        `${(retainedSeqCoverage * 100).toFixed(1)}% covered`,
      ];
    }),
  ];
}

async function inspectStoredRun(input: {
  runId: string;
  options: z.infer<typeof OptionsSchema>;
  strategies: readonly ContextStrategy[];
  model: ModelRef;
  context: CliContext;
  jsonMode: boolean;
}): Promise<void> {
  const { runId, options, strategies, model, context, jsonMode } = input;
  const strategy = strategies[0];
  if (strategy === undefined) {
    throw new ContextCommandError("usage");
  }
  const config = await context.loadConfig();
  const runtime = await createCommandRuntime(context, config, {
    readOnlyStore: true,
    model: {
      complete: () => Promise.reject(new ContextCommandError("context_model_call_forbidden")),
    },
  });
  try {
    const events: Event[] = [];
    for await (const event of runtime.store.read(runId)) {
      events.push(event);
    }
    if (events.length === 0) {
      throw new ContextCommandError("run_not_found");
    }
    const budget = {
      maxTokens: options.maxTokens,
      reserveOutputTokens: options.reserveOutput,
    };
    if (options.compare !== undefined) {
      const report = await comparisonReport({ events, strategies, model, budget });
      context.out.json((await import("@harness/context")).StrategyComparisonReportSchema, report);
      if (!jsonMode) {
        context.out.table(comparisonTableRows(report));
      }
      return;
    }
    const { HeuristicTokenCounter } = await import("@harness/context");
    const built = await strategy.build({
      events,
      budget,
      model,
      counter: new HeuristicTokenCounter(),
    });
    const result = await inspection({
      runId,
      events,
      strategy,
      model,
      budget,
      built,
      showContent: options.showContent === true,
    });
    if (options.showContent === true) {
      context.out.error("content_may_be_sensitive");
    }
    context.out.json(ContextInspectionSchema, result);
    if (!jsonMode) {
      context.out.print(humanSummary(result));
    }
  } finally {
    await runtime.close();
  }
}

async function runContextCommand(
  value: string,
  rawOptions: unknown,
  context: CliContext,
  jsonMode: boolean,
): Promise<void> {
  const runId = Id.safeParse(value);
  const options = OptionsSchema.parse(rawOptions);
  if (!runId.success) {
    throw new ContextCommandError("usage");
  }
  const { createStrategyRegistry, lookupContextStrategy } = await import("@harness/context");
  const registryModel = { provider: "heuristic", model: "default" };
  const names = selectedStrategyNames(options, createStrategyRegistry(registryModel), context);
  const config = await context.loadConfig();
  const model = modelReference(options.model, config.models.routing.default[0] ?? registryModel);
  const registry = createStrategyRegistry(model);
  const strategies = names.map((name) => lookupContextStrategy(registry, name));
  if (strategies.some((strategy) => strategy === undefined)) {
    throw new ContextCommandError("usage");
  }
  await inspectStoredRun({
    runId: runId.data,
    options,
    strategies: strategies.filter(
      (strategy): strategy is ContextStrategy => strategy !== undefined,
    ),
    model,
    context,
    jsonMode,
  });
}

/** Registers read-only inspection of a stored run with any built-in context strategy. */
export const contextCommand: CommandModule = {
  name: "context",
  /** Registers the `context` command. */
  register(program, context) {
    program
      .command("context")
      .description("Re-derive context from a stored run without calling a model")
      .argument("<runId>", "run identifier")
      .option("--strategy <name>", "context strategy", "naive")
      .option("--max-tokens <N>", "context token budget", tokenCount, 8_192)
      .option("--reserve-output <N>", "reserved output tokens", tokenCount, 1_024)
      .option("--model <provider/model>", "model reference for token estimates")
      .option("--show-content", "include stored tokenized message content")
      .option("--compare <strategies>", "compare two context strategies")
      .action(async (value: string, rawOptions: unknown) => {
        await runContextCommand(
          value,
          rawOptions,
          context,
          program.opts<{ json?: boolean }>().json === true,
        );
      });
  },
};
