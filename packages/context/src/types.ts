// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import {
  Code,
  Id,
  JsonValue,
  MessageSchema,
  type Event,
  type Message,
  type ModelRef,
} from "@harness/schemas";

/** Token budget available to a context strategy. */
export const ContextBudgetSchema = z
  .object({
    maxTokens: z.number().int().nonnegative(),
    reserveOutputTokens: z.number().int().nonnegative(),
  })
  .strict();

/** Inferred context token budget. */
export type ContextBudget = z.infer<typeof ContextBudgetSchema>;

/** A contiguous transcript unit that strategies may retain or drop atomically. */
export const TranscriptGroupSchema = z
  .object({
    runId: Id,
    seqs: z.array(z.number().int().nonnegative()).min(1),
    messages: z.array(MessageSchema).min(1),
    pinned: z.boolean(),
  })
  .strict();

/** Inferred transcript group. */
export type TranscriptGroup = z.infer<typeof TranscriptGroupSchema>;

/** A validated transcript reconstruction. */
export const TranscriptSchema = z.array(TranscriptGroupSchema);

/** Inferred transcript reconstruction. */
export type Transcript = z.infer<typeof TranscriptSchema>;

/** Counts tokens for normalized messages and a selected model. */
export interface TokenCounter {
  /**
   * Estimates the token count of provider-neutral messages.
   *
   * @param messages - Messages to count.
   * @param model - Provider and model used for the estimate.
   * @returns A nonnegative token estimate.
   */
  count(messages: readonly Message[], model: ModelRef): number;
}

/** Summary statistics returned with built context messages. */
export const ContextStatsSchema = z
  .object({
    messageCount: z.number().int().nonnegative(),
    estimatedTokens: z.number().int().nonnegative(),
    droppedGroups: z.number().int().nonnegative(),
    compactedRanges: z.number().int().nonnegative(),
    offloadedResults: z.number().int().nonnegative(),
  })
  .strict();

/** Inferred context build statistics. */
export type ContextStats = z.infer<typeof ContextStatsSchema>;

/** A retained event reference whose sequence is scoped to its run. */
export const RetainedEventRefSchema = z
  .object({
    runId: Id,
    seq: z.number().int().nonnegative(),
  })
  .strict();

/** Inferred run-scoped retained event reference. */
export type RetainedEventRef = z.infer<typeof RetainedEventRefSchema>;

/** Validated output of a context strategy. */
export const ContextResultSchema = z
  .object({
    messages: z.array(MessageSchema),
    stats: ContextStatsSchema,
    pinnedSeqs: z.array(z.number().int().nonnegative()),
    retainedSeqs: z.array(RetainedEventRefSchema),
  })
  .strict();

/** Inferred output of a context strategy. */
export type ContextResult = z.infer<typeof ContextResultSchema>;

/** Sequence ranges replaced by recorded context compactions. */
export const CompactedRangeSchema = z
  .object({
    fromSeq: z.number().int().nonnegative(),
    toSeq: z.number().int().nonnegative(),
  })
  .strict();

/** Inferred sequence range from a context compaction event. */
export type CompactedRange = z.infer<typeof CompactedRangeSchema>;

/** Result of deriving one context strategy for comparison. */
export const ComparisonSchema = z
  .object({
    strategy: Code,
    strategyVersion: Code,
    estimatedTokens: z.number().int().nonnegative(),
    messageCount: z.number().int().nonnegative(),
    droppedGroups: z.number().int().nonnegative(),
    compactedRanges: z.array(CompactedRangeSchema),
    retainedSeqs: z.array(RetainedEventRefSchema),
  })
  .strict();

/** Inferred comparison result for one context strategy. */
export type Comparison = z.infer<typeof ComparisonSchema>;

/** Strategy coverage in both directions for a comparison report. */
export const StrategyCoverageSchema = z
  .object({
    strategy: Code,
    comparedTo: Code,
    retainedSeqCoverage: z.number().min(0).max(1),
  })
  .strict();

/** Inferred directional retained-sequence coverage. */
export type StrategyCoverage = z.infer<typeof StrategyCoverageSchema>;

/** Machine-readable result emitted by `harness context --compare`. */
export const StrategyComparisonReportSchema = z
  .object({
    comparisons: z.array(ComparisonSchema).min(2),
    coverage: z.array(StrategyCoverageSchema).length(2),
  })
  .strict();

/** Inferred CLI comparison report. */
export type StrategyComparisonReport = z.infer<typeof StrategyComparisonReportSchema>;

/** Serializable context strategy state stored with a run checkpoint. */
export const ContextSnapshotSchema = z
  .object({
    strategyId: Code,
    strategyVersion: Code,
    calibration: JsonValue,
  })
  .strict();

/** Inferred serializable strategy state. */
export type ContextSnapshot = z.infer<typeof ContextSnapshotSchema>;

/** Inputs supplied when rebuilding context from its event log. */
export interface ContextStrategyInput {
  readonly events: readonly Event[];
  /** Earlier run logs in a continuation chain, oldest first. */
  readonly previousEventLogs?: readonly (readonly Event[])[];
  readonly budget: ContextBudget;
  readonly model: ModelRef;
  readonly counter: TokenCounter;
}

/** Builds a provider-independent context view from an immutable event history. */
export interface ContextStrategy {
  /** Stable strategy identifier recorded with checkpoints. */
  readonly id: Code;
  /** Version of the strategy's output behavior. */
  readonly version: Code;
  /**
   * Rebuilds context without mutating the event log or performing side effects.
   *
   * @param input - Event history and the model/budget dependencies for the build.
   * @returns Context messages and deterministic build statistics.
   */
  build(input: ContextStrategyInput): Promise<ContextResult>;
}
