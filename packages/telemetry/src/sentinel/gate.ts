// SPDX-License-Identifier: Apache-2.0
import { HarnessError, Id as IdSchema, type Id, type TelemetryConfig } from "@harness/schemas";
import { z } from "zod";
import { countSentinelScopeReduced } from "../metrics.js";
import { activeRuns, type ActiveRuns } from "./active-runs.js";
import { SentinelMatcher } from "./matcher.js";
import type { VaultRunView } from "./run-values.js";

const SentinelGateOptionsSchema = z
  .object({
    maxCombinedValues: z.number().int().positive().default(100_000),
    maxPrepareMs: z.number().positive().default(250),
    maxScanMs: z.number().positive().default(5),
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

/** Metadata-only notification for the trip queue introduced by task 8.4. */
export const SentinelTripSchema = z
  .object({
    runId: IdSchema.optional(),
    reason: z.enum(["hit", "error", "timeout"]),
  })
  .strict();

/** Trip metadata containing no matched values or tokens. */
export type SentinelTrip = z.infer<typeof SentinelTripSchema>;

/** Input passed to the sentinel gate. */
export type SentinelGateInput = z.infer<typeof SentinelGateInputSchema>;

/** Matcher surface used by the gate and injectable in failure tests. */
export interface SentinelMatcherLike {
  hasMatch(text: string): boolean;
}

/** Options for building a fail-closed export gate. */
export interface SentinelGateOptions {
  readonly maxCombinedValues?: number;
  readonly maxPrepareMs?: number;
  readonly maxScanMs?: number;
  readonly now?: () => number;
  readonly matcherForValues?: (values: readonly string[]) => SentinelMatcherLike;
  readonly onTrip?: (trip: SentinelTrip) => void;
}

interface CachedMatcher {
  readonly version: number;
  readonly matcher: SentinelMatcherLike;
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
  private readonly now: () => number;
  private readonly matcherForValues: (values: readonly string[]) => SentinelMatcherLike;
  private readonly onTrip: ((trip: SentinelTrip) => void) | undefined;
  private readonly runMatchers = new Map<Id, CachedMatcher>();
  private combinedMatcher:
    { readonly key: string; readonly matcher: SentinelMatcherLike } | undefined;
  private readonly trips: SentinelTrip[] = [];

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
    const { maxCombinedValues, maxPrepareMs, maxScanMs } = SentinelGateOptionsSchema.parse({
      maxCombinedValues: options.maxCombinedValues,
      maxPrepareMs: options.maxPrepareMs,
      maxScanMs: options.maxScanMs,
    });
    this.maxCombinedValues = maxCombinedValues;
    this.maxPrepareMs = maxPrepareMs;
    this.maxScanMs = maxScanMs;
    this.now = options.now ?? (() => performance.now());
    this.matcherForValues =
      options.matcherForValues ?? ((patterns) => SentinelMatcher.forValues(patterns));
    this.onTrip = options.onTrip;
  }

  /** Check canonicalized sanitized text against the relevant vault values. */
  async check(input: SentinelGateInput): Promise<SentinelGateResult> {
    let runId: Id | undefined;
    try {
      const request = SentinelGateInputSchema.parse(input);
      runId = request.runId;
      let matcher: SentinelMatcherLike;
      try {
        matcher = await this.prepareMatcher(request);
      } catch (error) {
        const reason = error instanceof SentinelPreparationTimeoutError ? "timeout" : "error";
        this.enqueueTrip(runId, reason);
        return { ok: false, reason };
      }

      const scanStartedAt = this.now();
      let matched: boolean;
      try {
        matched = matcher.hasMatch(request.text);
      } catch {
        const reason = this.scanStatus(scanStartedAt) === "timeout" ? "timeout" : "error";
        this.enqueueTrip(runId, reason);
        return { ok: false, reason };
      }
      const scanStatus = this.scanStatus(scanStartedAt);
      if (scanStatus !== "ok") {
        const reason = scanStatus === "timeout" ? "timeout" : "error";
        this.enqueueTrip(runId, reason);
        return { ok: false, reason };
      }
      if (matched) {
        this.enqueueTrip(runId, "hit");
        return { ok: false, reason: "hit" };
      }
      return { ok: true };
    } catch {
      this.enqueueTrip(runId, "error");
      return { ok: false, reason: "error" };
    }
  }

  /** Drain queued metadata-only trip notifications for the run loop. */
  drainTrips(): readonly SentinelTrip[] {
    return this.trips.splice(0).map((trip) => ({ ...trip }));
  }

  private async prepareMatcher(request: SentinelGateInput): Promise<SentinelMatcherLike> {
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

  private async runMatcher(runId: Id): Promise<SentinelMatcherLike> {
    const valueSet = await this.values.valuesFor(runId);
    const cached = this.runMatchers.get(runId);
    if (cached?.version === valueSet.version) {
      this.runMatchers.delete(runId);
      this.runMatchers.set(runId, cached);
      return cached.matcher;
    }
    const matcher = this.matcherForValues(valueSet.values);
    this.runMatchers.delete(runId);
    this.runMatchers.set(runId, { version: valueSet.version, matcher });
    while (this.runMatchers.size > 64) {
      const oldestRunId = this.runMatchers.keys().next().value;
      if (oldestRunId === undefined) {
        break;
      }
      this.runMatchers.delete(oldestRunId);
    }
    return matcher;
  }

  private async globalMatcher(): Promise<SentinelMatcherLike> {
    const runIds = this.runs.runIds();
    const valueSets = await Promise.all(
      runIds.map(async (runId) => ({
        runId,
        valueSet: await this.values.valuesFor(runId),
      })),
    );
    const key = JSON.stringify(valueSets.map(({ runId, valueSet }) => [runId, valueSet.version]));
    if (this.combinedMatcher?.key === key) {
      return this.combinedMatcher.matcher;
    }
    const combined = [...new Set(valueSets.flatMap(({ valueSet }) => [...valueSet.values]))];
    if (combined.length > this.maxCombinedValues) {
      const matchers = await Promise.all(valueSets.map(({ runId }) => this.runMatcher(runId)));
      const matcher = {
        hasMatch: (text: string) => matchers.some((runMatcher) => runMatcher.hasMatch(text)),
      };
      this.combinedMatcher = { key, matcher };
      countSentinelScopeReduced();
      return matcher;
    }
    const matcher = this.matcherForValues(combined);
    this.combinedMatcher = { key, matcher };
    return matcher;
  }

  private enqueueTrip(runId: Id | undefined, reason: SentinelTrip["reason"]): void {
    const trip = SentinelTripSchema.parse({ ...(runId === undefined ? {} : { runId }), reason });
    this.trips.push(trip);
    try {
      this.onTrip?.(trip);
    } catch {
      return;
    }
  }
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
