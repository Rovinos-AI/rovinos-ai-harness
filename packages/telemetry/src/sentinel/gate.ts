// SPDX-License-Identifier: Apache-2.0
import {
  Code,
  HarnessError,
  Id as IdSchema,
  type Code as EntityCode,
  type Id,
  type TelemetryConfig,
} from "@harness/schemas";
import { z } from "zod";
import { countSentinelScopeReduced } from "../metrics.js";
import { activeRuns, type ActiveRuns } from "./active-runs.js";
import { SentinelMatcher } from "./matcher.js";
import { sentinelTripQueue, type TripQueue } from "./trips.js";
import type { RunValueSet, VaultRunView } from "./run-values.js";
import { fitsPatternSizeLimit, normalizeForScan, variantsOf } from "./variants.js";

const SentinelGateOptionsSchema = z
  .object({
    maxCombinedValues: z.number().int().positive().default(100_000),
    maxPrepareMs: z.number().positive().default(250),
    maxScanMs: z.number().positive().default(5),
    minValueLength: z.number().int().min(1).default(6),
  })
  .strict();

/** Input contract for the sanitized payload checked at the export boundary. */
export const SentinelGateInputSchema = z
  .object({
    runId: IdSchema.optional(),
    text: z.string(),
  })
  .strict();

/** Result contract for fail-closed sentinel scans. */
export const SentinelGateResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }).strict(),
  z
    .object({
      ok: z.literal(false),
      reason: z.enum(["hit", "error", "timeout"]),
    })
    .strict(),
]);

/** The fail-closed result of scanning a sanitized telemetry payload. */
export type SentinelGateResult = z.infer<typeof SentinelGateResultSchema>;

/** Input passed to the sentinel gate. */
export type SentinelGateInput = z.infer<typeof SentinelGateInputSchema>;

/** Matcher surface used by the gate and injectable in failure tests. */
export interface SentinelMatcherLike {
  findAll(text: string, shouldStop?: () => boolean): readonly { readonly patternIndex: number }[];
}

/** Options for building a fail-closed export gate. */
export interface SentinelGateOptions {
  readonly maxCombinedValues?: number;
  readonly maxPrepareMs?: number;
  readonly maxScanMs?: number;
  readonly minValueLength?: number;
  readonly now?: () => number;
  readonly matcherForValues?: (values: readonly string[]) => SentinelMatcherLike;
  readonly tripQueue?: TripQueue;
}

interface CachedMatcher {
  readonly version: number;
  readonly matcher: SentinelMatcherLike;
  readonly entityTypesByValue: readonly (readonly EntityCode[])[];
}

interface PreparedMatcher {
  readonly matcher: SentinelMatcherLike;
  readonly entityTypesByValue: readonly (readonly EntityCode[])[];
}

class SentinelPreparationTimeoutError extends Error {}

/**
 * Selects cached run-scoped or active-run matchers and rejects any scan that hits,
 * errors, or exceeds its budget.
 */
export class SentinelGate {
  private readonly maxCombinedValues: number;
  private readonly maxPrepareMs: number;
  private readonly maxScanMs: number;
  private readonly minValueLength: number;
  private readonly now: () => number;
  private readonly matcherForValues: (values: readonly string[]) => SentinelMatcherLike;
  private readonly tripQueue: TripQueue;
  private readonly runMatchers = new Map<Id, CachedMatcher>();
  private combinedMatcher: ({ readonly key: string } & PreparedMatcher) | undefined;

  /**
   * @param values Versioned, read-only vault values.
   * @param runs Registry of process-local active and recently finished runs.
   * @param options Preparation and scan budgets, matcher and metadata-only trip hook.
   */
  constructor(
    private readonly values: VaultRunView,
    private readonly runs: ActiveRuns = activeRuns,
    options: SentinelGateOptions = {},
  ) {
    const { maxCombinedValues, maxPrepareMs, maxScanMs, minValueLength } =
      SentinelGateOptionsSchema.parse({
        maxCombinedValues: options.maxCombinedValues,
        maxPrepareMs: options.maxPrepareMs,
        maxScanMs: options.maxScanMs,
        minValueLength: options.minValueLength,
      });
    this.maxCombinedValues = maxCombinedValues;
    this.maxPrepareMs = maxPrepareMs;
    this.maxScanMs = maxScanMs;
    this.minValueLength = minValueLength;
    this.now = options.now ?? (() => performance.now());
    this.matcherForValues =
      options.matcherForValues ??
      ((patterns) =>
        SentinelMatcher.forValues(patterns, (value) => variantsOf(value, this.minValueLength)));
    this.tripQueue = options.tripQueue ?? sentinelTripQueue;
  }

  /** Check canonicalized sanitized text against the relevant vault values. */
  async check(input: SentinelGateInput): Promise<SentinelGateResult> {
    let runId: Id | undefined;
    try {
      const request = SentinelGateInputSchema.parse(input);
      runId = request.runId;
      let preparedMatcher: PreparedMatcher;
      try {
        preparedMatcher = await this.prepareMatcher(request);
      } catch (error) {
        const reason = error instanceof SentinelPreparationTimeoutError ? "timeout" : "error";
        this.enqueueTrip(runId, []);
        return { ok: false, reason };
      }

      const scanStartedAt = this.now();
      let matches: readonly { readonly patternIndex: number }[];
      try {
        const matchedIndexes = new Set<number>();
        for (const text of new Set(normalizeForScan(request.text))) {
          for (const { patternIndex } of preparedMatcher.matcher.findAll(
            text,
            () => this.scanStatus(scanStartedAt) !== "ok",
          )) {
            matchedIndexes.add(patternIndex);
          }
        }
        matches = [...matchedIndexes].map((patternIndex) => ({ patternIndex }));
      } catch {
        const reason = this.scanStatus(scanStartedAt) === "timeout" ? "timeout" : "error";
        this.enqueueTrip(runId, []);
        return { ok: false, reason };
      }
      const scanStatus = this.scanStatus(scanStartedAt);
      if (scanStatus !== "ok") {
        const reason = scanStatus === "timeout" ? "timeout" : "error";
        this.enqueueTrip(runId, []);
        return { ok: false, reason };
      }
      if (matches.length > 0) {
        this.enqueueTrip(runId, entitiesForMatches(matches, preparedMatcher.entityTypesByValue));
        return { ok: false, reason: "hit" };
      }
      return { ok: true };
    } catch {
      this.enqueueTrip(runId, []);
      return { ok: false, reason: "error" };
    }
  }

  private async prepareMatcher(request: SentinelGateInput): Promise<PreparedMatcher> {
    const startedAt = this.now();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const matcher = await Promise.race([
        request.runId === undefined ? this.globalMatcher() : this.runMatcher(request.runId),
        new Promise<undefined>((resolve) => {
          timeout = setTimeout(() => {
            resolve(undefined);
          }, this.maxPrepareMs);
        }),
      ]);
      if (matcher === undefined || this.now() - startedAt > this.maxPrepareMs) {
        throw new SentinelPreparationTimeoutError();
      }
      return matcher;
    } catch (error) {
      let timedOut: boolean;
      try {
        timedOut = this.now() - startedAt > this.maxPrepareMs;
      } catch {
        throw error;
      }
      if (timedOut) {
        throw new SentinelPreparationTimeoutError();
      }
      throw error;
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
  }

  private scanStatus(startedAt: number): "ok" | "timeout" | "error" {
    try {
      return this.now() - startedAt > this.maxScanMs ? "timeout" : "ok";
    } catch {
      return "error";
    }
  }

  private async runMatcher(runId: Id): Promise<CachedMatcher> {
    const valueSet = await this.values.valuesFor(runId);
    const cached = this.runMatchers.get(runId);
    if (cached?.version === valueSet.version) {
      this.runMatchers.delete(runId);
      this.runMatchers.set(runId, cached);
      return cached;
    }
    const matcher = this.matcherForValues(valueSet.values);
    const entityTypesByValue = valueSet.values.map((_, index) =>
      valueSet.entityTypesForValue(index),
    );
    const prepared = { version: valueSet.version, matcher, entityTypesByValue };
    this.runMatchers.delete(runId);
    this.runMatchers.set(runId, prepared);
    while (this.runMatchers.size > 64) {
      const oldestRunId = this.runMatchers.keys().next().value;
      if (oldestRunId === undefined) {
        break;
      }
      this.runMatchers.delete(oldestRunId);
    }
    return prepared;
  }

  private async globalMatcher(): Promise<PreparedMatcher> {
    const runIds = this.runs.runIds();
    const valueSets = await Promise.all(
      runIds.map(async (runId) => ({
        runId,
        valueSet: await this.values.valuesFor(runId),
      })),
    );
    const key = JSON.stringify(valueSets.map(({ runId, valueSet }) => [runId, valueSet.version]));
    if (this.combinedMatcher?.key === key) {
      return this.combinedMatcher;
    }
    const combined = combineValueSets(valueSets.map(({ valueSet }) => valueSet));
    if (
      combined.values.length > this.maxCombinedValues ||
      !fitsPatternSizeLimit(combined.values, this.minValueLength)
    ) {
      const matchers = await Promise.all(valueSets.map(({ runId }) => this.runMatcher(runId)));
      const offsets: number[] = [];
      const entityTypesByValue: (readonly EntityCode[])[] = [];
      for (const runMatcher of matchers) {
        const offset = entityTypesByValue.length;
        offsets.push(offset);
        entityTypesByValue.push(...runMatcher.entityTypesByValue);
      }
      const matcher: SentinelMatcherLike = {
        findAll: (text, shouldStop) =>
          matchers.flatMap((runMatcher, index) =>
            runMatcher.matcher.findAll(text, shouldStop).map(({ patternIndex }) => ({
              patternIndex: patternIndex + (offsets[index] ?? 0),
            })),
          ),
      };
      this.combinedMatcher = { key, matcher, entityTypesByValue };
      countSentinelScopeReduced();
      return this.combinedMatcher;
    }
    const matcher = this.matcherForValues(combined.values);
    this.combinedMatcher = { key, matcher, entityTypesByValue: combined.entityTypesByValue };
    return this.combinedMatcher;
  }

  private enqueueTrip(
    runId: Id | undefined,
    entities: readonly { type: EntityCode; count: number }[],
  ): void {
    this.tripQueue.enqueue({
      ...(runId === undefined ? {} : { runId }),
      entities: [...entities],
    });
  }
}

function combineValueSets(valueSets: readonly RunValueSet[]): {
  readonly values: readonly string[];
  readonly entityTypesByValue: readonly (readonly EntityCode[])[];
} {
  const values: string[] = [];
  const entityTypesByValue: EntityCode[][] = [];
  const indexes = new Map<string, number>();
  for (const valueSet of valueSets) {
    for (const [index, value] of valueSet.values.entries()) {
      const existingIndex = indexes.get(value);
      if (existingIndex === undefined) {
        indexes.set(value, values.length);
        values.push(value);
        entityTypesByValue.push([...valueSet.entityTypesForValue(index)]);
      } else {
        mergeEntityTypes(entityTypesByValue[existingIndex], valueSet.entityTypesForValue(index));
      }
    }
  }
  return { values, entityTypesByValue };
}

function mergeEntityTypes(target: EntityCode[] | undefined, source: readonly EntityCode[]): void {
  if (target === undefined) {
    return;
  }
  for (const type of source) {
    if (!target.includes(type)) {
      target.push(type);
    }
  }
}

function entitiesForMatches(
  matches: readonly { readonly patternIndex: number }[],
  entityTypesByValue: readonly (readonly EntityCode[])[],
): { type: EntityCode; count: number }[] {
  const counts = new Map<EntityCode, number>();
  const matchedIndexes = new Set<number>();
  for (const { patternIndex } of matches) {
    if (matchedIndexes.has(patternIndex)) {
      continue;
    }
    matchedIndexes.add(patternIndex);
    for (const type of entityTypesByValue[patternIndex] ?? []) {
      counts.set(type, (counts.get(type) ?? 0) + 1);
    }
  }
  return [...counts]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([type, count]) => ({ type: Code.parse(type), count }));
}

/** Ensure SDK processor pipelines fail closed unless explicitly disabled outside production. */
export function assertSentinelGate(
  gate: SentinelGate | undefined,
  telemetry: TelemetryConfig | undefined,
  nodeEnv = process.env.NODE_ENV,
): void {
  if (gate === undefined && !(telemetry?.sentinel.enabled === false && nodeEnv !== "production")) {
    throw new SentinelRequiredError();
  }
}

/** Error raised when an SDK pipeline would be built without its required sentinel. */
export class SentinelRequiredError extends HarnessError {
  readonly code = "sentinel_required";

  constructor() {
    super("A telemetry sentinel gate is required.");
  }
}
