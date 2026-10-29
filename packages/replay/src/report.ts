// SPDX-License-Identifier: Apache-2.0
import { Code, HarnessError, Id, RunStatus } from "@rovinos/schemas";
import { z } from "zod";
import { hasReplayDifferences } from "./diff-classification.js";
import { diffNormalizedRuns, normalizeRun } from "./diff.js";
import type { DiffResult } from "./diff.js";
import type { ReplayOutcome } from "./replay.js";

const normalizedFields = new Set([
  "kind",
  "provider",
  "model",
  "inputTokens",
  "outputTokens",
  "latencyMs",
  "schemaValid",
  "repairAttempts",
  "finishReason",
  "toolId",
  "boundary",
  "outcome",
  "errorCode",
  "policyDecision",
  "ruleId",
  "decision",
  "decidedBy",
  "approverPseudonym",
  "reason",
  "waitMs",
  "source",
  "mode",
  "round",
  "action",
  "entities",
  "atSeq",
  "hasWorkspaceRef",
  "from",
  "to",
  "budget",
  "limit",
  "observed",
  "costMicros",
  "type",
  "count",
  "role",
  "childRunId",
  "parentCallId",
  "configHash",
  "requestedByPseudonym",
  "callId",
  "approvalId",
  "requestId",
  "checkpointId",
  "replayOf",
]);

const normalizedString = z.string().refine(
  (value) =>
    Code.safeParse(value).success ||
    /^(?:call|approval|request|checkpoint|childRun|run)#\d+$/u.test(value) ||
    /^p_[a-z2-7]{26}$/u.test(value) ||
    /^[a-f0-9]{64}$/u.test(value),
  { error: "invalid_meta_value" },
);

type NormalizedValue =
  | string
  | number
  | boolean
  | readonly NormalizedValue[]
  | { readonly [key: string]: NormalizedValue };

const normalizedValue: z.ZodType<NormalizedValue> = z.lazy(() =>
  z.union([
    normalizedString,
    z.number(),
    z.boolean(),
    z.array(normalizedValue),
    z.record(z.string(), normalizedValue).superRefine((record, context) => {
      for (const key of Object.keys(record)) {
        if (!normalizedFields.has(key)) {
          context.addIssue({ code: "custom", message: "invalid_meta_field", path: [key] });
        }
      }
    }),
  ]),
);

/** Strict schema for one normalized, content-free safe-event signature. */
export const NormalizedEventSchema = z
  .record(z.string(), normalizedValue)
  .superRefine((record, context) => {
    for (const key of Object.keys(record)) {
      if (!normalizedFields.has(key)) {
        context.addIssue({ code: "custom", message: "invalid_meta_field", path: [key] });
      }
    }
    if (typeof record.kind !== "string" || !Code.safeParse(record.kind).success) {
      context.addIssue({ code: "custom", message: "invalid_event_kind", path: ["kind"] });
    }
  });

const ScalarSchema = z.union([normalizedString, z.number(), z.boolean()]);

const DiffFieldSchema = z
  .object({
    a: ScalarSchema,
    b: ScalarSchema,
    field: Code,
  })
  .strict();

const DiffEntrySchema = z
  .object({
    class: z.enum(["behavioral", "noise"]),
    eventKind: Code,
    fields: DiffFieldSchema.array().optional(),
    index: z.number().int().nonnegative(),
    kind: z.enum(["added", "removed", "changed"]),
  })
  .strict();

const DiffSummarySchema = z
  .object({
    added: z.number().int().nonnegative(),
    behavioral: z.number().int().nonnegative(),
    changed: z.number().int().nonnegative(),
    noise: z.number().int().nonnegative(),
    removed: z.number().int().nonnegative(),
  })
  .strict();

/** Machine-readable, metadata-only report for a replay and its normalized diff. */
export const ReplayReportSchema = z
  .object({
    approximate: z.boolean(),
    configDrift: z.boolean(),
    divergence: z
      .object({
        code: z.enum(["replay_divergence", "replay_missing_result"]),
        seq: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    entries: DiffEntrySchema.array(),
    goldenMatch: z.boolean().optional(),
    originalRunId: Id,
    policyDrift: z.boolean(),
    replayRunId: Id,
    schemaVersion: z.literal(1),
    status: z.union([RunStatus, z.literal("error")]),
    summary: DiffSummarySchema,
  })
  .strict();

/** Inferred replay report contract. */
export type ReplayReport = z.infer<typeof ReplayReportSchema>;

/** Strict signature file contract for committed synthetic replay baselines. */
export const GoldenSignatureSchema = z
  .object({
    schemaVersion: z.literal(1),
    containsRealData: z.literal(false),
    signature: NormalizedEventSchema.array(),
  })
  .strict();

/** Inferred golden signature file contract. */
export type GoldenSignature = z.infer<typeof GoldenSignatureSchema>;

/** Inputs used to create a metadata-only report from one replay and its diff. */
export interface CreateReplayReportInput {
  readonly originalRunId: string;
  readonly outcome: ReplayOutcome;
  readonly diff: DiffResult;
  readonly goldenMatch?: boolean;
}

/**
 * Creates a schema-validated report from replay metadata and a normalized diff.
 *
 * @param input - Original run ID, replay outcome, diff, and optional golden match result.
 * @returns A strict metadata-only report.
 */
export function createReplayReport(input: CreateReplayReportInput): ReplayReport {
  return ReplayReportSchema.parse({
    schemaVersion: 1,
    originalRunId: input.originalRunId,
    replayRunId: input.outcome.replayRunId,
    status: input.outcome.status,
    configDrift: input.outcome.configDrift,
    policyDrift: input.outcome.policyDrift,
    approximate: input.diff.approximate,
    summary: input.diff.summary,
    entries: input.diff.entries,
    ...(input.outcome.divergence === undefined ? {} : { divergence: input.outcome.divergence }),
    ...(input.goldenMatch === undefined ? {} : { goldenMatch: input.goldenMatch }),
  });
}

function sortedJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortedJsonValue);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const entries = Object.entries(value).sort(([keyA], [keyB]) => compareKeys(keyA, keyB));
  return Object.fromEntries(entries.map(([key, entry]) => [key, sortedJsonValue(entry)]));
}

function compareKeys(keyA: string, keyB: string): number {
  if (keyA < keyB) {
    return -1;
  }
  if (keyA > keyB) {
    return 1;
  }
  return 0;
}

function stableJson(value: unknown): string {
  const serialized = JSON.stringify(sortedJsonValue(value), null, 2);
  if (typeof serialized !== "string") {
    throw new TypeError("Validated replay data could not be serialized.");
  }
  return `${serialized}\n`;
}

/**
 * Renders a report with deterministic, recursively sorted JSON keys.
 *
 * @param report - A report to validate and serialize.
 * @returns Indented JSON terminated by one newline.
 */
export function renderReplayReportJson(report: ReplayReport): string {
  return stableJson(ReplayReportSchema.parse(report));
}

/**
 * Renders a report summary and at most its first 50 metadata-only diff entries.
 *
 * @param report - A report to validate and render.
 * @returns Human-readable text with no event content.
 */
export function renderReplayReportText(report: ReplayReport): string {
  const validated = ReplayReportSchema.parse(report);
  const { summary } = validated;
  const lines = [
    `Replay ${validated.originalRunId} -> ${validated.replayRunId}`,
    `status: ${validated.status}; configDrift: ${String(validated.configDrift)}; policyDrift: ${String(validated.policyDrift)}; approximate: ${String(validated.approximate)}`,
    `diff: ${String(summary.added)} added, ${String(summary.removed)} removed, ${String(summary.changed)} changed (${String(summary.behavioral)} behavioral, ${String(summary.noise)} noise)`,
  ];
  if (validated.goldenMatch !== undefined) {
    lines.push(`goldenMatch: ${String(validated.goldenMatch)}`);
  }
  if (validated.divergence !== undefined) {
    lines.push(
      `divergence: ${validated.divergence.code} at seq ${String(validated.divergence.seq)}`,
    );
  }
  for (const entry of validated.entries.slice(0, 50)) {
    lines.push(`${entry.kind} ${entry.eventKind} at ${String(entry.index)} (${entry.class})`);
    for (const field of entry.fields ?? []) {
      lines.push(`  ${field.field}: ${String(field.a)} -> ${String(field.b)}`);
    }
  }
  const omitted = validated.entries.length - 50;
  if (omitted > 0) {
    lines.push(`${String(omitted)} additional entries omitted`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Produces a golden signature from an event log using the safe normalized projection.
 *
 * @param events - Validated source events.
 * @returns A schema-validated synthetic-data signature file.
 */
export function createGoldenSignature(
  events: Parameters<typeof normalizeRun>[0],
): GoldenSignature {
  return GoldenSignatureSchema.parse({
    schemaVersion: 1,
    containsRealData: false,
    signature: normalizeRun(events),
  });
}

/** Result of comparing a replay signature with a parsed golden signature. */
export interface GoldenComparison {
  readonly match: boolean;
  readonly diff: DiffResult;
}

/**
 * Compares a replay's normalized safe signature with a golden baseline.
 *
 * @param events - Validated replay events.
 * @param golden - Parsed or parseable golden signature data.
 * @returns Exact signature match status and a noise-aware diff.
 */
export function compareGoldenSignature(
  events: Parameters<typeof normalizeRun>[0],
  golden: GoldenSignature,
): GoldenComparison {
  const baseline = GoldenSignatureSchema.parse(golden);
  const actual = createGoldenSignature(events);
  return {
    match: stableJson(actual.signature) === stableJson(baseline.signature),
    diff: diffNormalizedRuns(baseline.signature, actual.signature),
  };
}

/**
 * Renders a golden signature with deterministic, recursively sorted JSON keys.
 *
 * @param golden - A signature file to validate and serialize.
 * @returns Indented JSON terminated by one newline.
 */
export function renderGoldenSignatureJson(golden: GoldenSignature): string {
  return stableJson(GoldenSignatureSchema.parse(golden));
}

/** Error raised when an explicit baseline update is unsafe or forbidden. */
export class BaselineUpdateRefusedError extends HarnessError {
  override readonly code = "baseline_update_refused";

  constructor() {
    super("Replay baseline update was refused.");
  }
}

/** Conditions that must all permit an explicit baseline update. */
export interface BaselineUpdateConditions {
  readonly divergence?: ReplayOutcome["divergence"];
  readonly inCi: boolean;
  readonly forceInCi: boolean;
}

/**
 * Refuses baseline updates after divergence or in CI without explicit force.
 *
 * @param conditions - Replay outcome and CI override state.
 * @throws BaselineUpdateRefusedError when the update must not proceed.
 */
export function assertBaselineUpdateAllowed(conditions: BaselineUpdateConditions): void {
  if (conditions.divergence !== undefined || (conditions.inCi && !conditions.forceInCi)) {
    throw new BaselineUpdateRefusedError();
  }
}

/**
 * Maps replay report differences to the task's stable CI exit-code table.
 *
 * @param report - Validated replay report.
 * @param strict - Whether noise-only differences should fail.
 * @returns 0 for accepted results, 1 for differences, or 8 for replay failure.
 */
export function replayReportExitCode(report: ReplayReport, strict = false): 0 | 1 | 8 {
  const validated = ReplayReportSchema.parse(report);
  if (validated.status === "error" || validated.divergence !== undefined) {
    return 8;
  }
  if (hasReplayDifferences(validated.summary, strict)) {
    return 1;
  }
  return 0;
}
