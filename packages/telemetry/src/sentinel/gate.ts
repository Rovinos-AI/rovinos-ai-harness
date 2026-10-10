// SPDX-License-Identifier: Apache-2.0
import { HarnessError, Id, type TelemetryConfig } from "@harness/schemas";
import { z } from "zod";
import { countSentinelScopeReduced } from "../metrics.js";
import { ActiveRuns, activeRuns } from "./active-runs.js";
import { SentinelMatcher } from "./matcher.js";
import { VaultRunView } from "./run-values.js";

const SentinelGateOptionsSchema = z
  .object({
    maxCombinedValues: z.number().int().positive().default(100_000),
    maxScanMs: z.number().positive().default(5),
  })
  .strict();

/** The fail-closed result of scanning a sanitized telemetry payload. */
export type SentinelGateResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "hit" | "error" | "timeout" };

/** Metadata-only notification for the trip queue introduced by task 8.4. */
export interface SentinelTrip {
  readonly runId?: Id;
  readonly reason: "hit" | "error" | "timeout";
}

/** Matcher surface used by the gate and injectable in failure tests. */
export interface SentinelMatcherLike {
  hasMatch(text: string): boolean;
}

/** Options for building a fail-closed export gate. */
export interface SentinelGateOptions {
  readonly maxCombinedValues?: number;
  readonly maxScanMs?: number;
  readonly now?: () => number;
  readonly matcherForValues?: (values: readonly string[]) => SentinelMatcherLike;
  readonly onTrip?: (trip: SentinelTrip) => void;
}

interface CachedMatcher {
  readonly version: number;
  readonly matcher: SentinelMatcherLike;
}

/**
 * Selects cached run-scoped or active-run matchers and rejects any scan that hits,
 * errors, or exceeds its budget.
 */
export class SentinelGate {
  private readonly maxCombinedValues: number;
  private readonly maxScanMs: number;
  private readonly now: () => number;
  private readonly matcherForValues: (values: readonly string[]) => SentinelMatcherLike;
  private readonly onTrip: ((trip: SentinelTrip) => void) | undefined;
  private readonly runMatchers = new Map<Id, CachedMatcher>();
  private combinedMatcher: { readonly key: string; readonly matcher: SentinelMatcherLike } | undefined;

  /**
   * @param values Versioned, read-only vault values.
   * @param runs Registry of process-local active and recently finished runs.
   * @param options Scan budget, matcher and metadata-only trip hook.
   */
  constructor(
    private readonly values: VaultRunView,
    private readonly runs: ActiveRuns = activeRuns,
    options: SentinelGateOptions = {},
  ) {
    const { maxCombinedValues, maxScanMs } = SentinelGateOptionsSchema.parse({
      maxCombinedValues: options.maxCombinedValues,
      maxScanMs: options.maxScanMs,
    });
    this.maxCombinedValues = maxCombinedValues;
    this.maxScanMs = maxScanMs;
    this.now = options.now ?? (() => performance.now());
    this.matcherForValues =
      options.matcherForValues ?? ((patterns) => SentinelMatcher.forValues(patterns));
    this.onTrip = options.onTrip;
  }

  /** Check canonicalized sanitized text against the relevant vault values. */
  async check(input: { readonly runId?: Id; readonly text: string }): Promise<SentinelGateResult> {
    const startedAt = this.now();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const timedOut = new Promise<SentinelGateResult>((resolve) => {
        timeout = setTimeout(() => resolve({ ok: false, reason: "timeout" }), this.maxScanMs);
      });
      const scan = Promise.resolve().then(async (): Promise<SentinelGateResult> => {
        const matcher =
          input.runId === undefined
            ? await this.globalMatcher()
            : await this.runMatcher(input.runId);
        if (matcher === undefined) {
          return { ok: false, reason: "error" };
        }
        return matcher.hasMatch(input.text)
          ? { ok: false, reason: "hit" }
          : { ok: true };
      });
      const result = await Promise.race([scan, timedOut]);
      if (!result.ok) {
        this.enqueueTrip(input.runId, result.reason);
        return result;
      }
      if (this.now() - startedAt > this.maxScanMs) {
        this.enqueueTrip(input.runId, "timeout");
        return { ok: false, reason: "timeout" };
      }
      return result;
    } catch {
      this.enqueueTrip(input.runId, "error");
      return { ok: false, reason: "error" };
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
  }

  private async runMatcher(runId: Id): Promise<SentinelMatcherLike> {
    const valueSet = await this.values.valuesFor(runId);
    const cached = this.runMatchers.get(runId);
    if (cached?.version === valueSet.version) {
      return cached.matcher;
    }
    const matcher = this.matcherForValues(valueSet.values);
    this.runMatchers.set(runId, { version: valueSet.version, matcher });
    return matcher;
  }

  private async globalMatcher(): Promise<SentinelMatcherLike> {
    const runIds = this.runs.runIds();
    const valueSets = await Promise.all(runIds.map(async (runId) => ({
      runId,
      valueSet: await this.values.valuesFor(runId),
    })));
    const key = JSON.stringify(
      valueSets.map(({ runId, valueSet }) => [runId, valueSet.version]),
    );
    if (this.combinedMatcher?.key === key) {
      return this.combinedMatcher.matcher;
    }
    const combined = valueSets.flatMap(({ valueSet }) => [...valueSet.values]);
    if (combined.length > this.maxCombinedValues) {
      countSentinelScopeReduced();
      const matchers = await Promise.all(
        valueSets.map(({ runId }) => this.runMatcher(runId)),
      );
      return {
        hasMatch: (text) => matchers.some((matcher) => matcher.hasMatch(text)),
      };
    }
    const matcher = this.matcherForValues(combined);
    this.combinedMatcher = { key, matcher };
    return matcher;
  }

  private enqueueTrip(runId: Id | undefined, reason: SentinelTrip["reason"]): void {
    try {
      this.onTrip?.({ ...(runId === undefined ? {} : { runId }), reason });
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
