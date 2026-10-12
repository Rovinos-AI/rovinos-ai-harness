// SPDX-License-Identifier: Apache-2.0
import { inspect } from "node:util";
import type { Id } from "@harness/schemas";
import { z } from "zod";
import { countSkippedShortValues } from "../metrics.js";

const DEFAULT_MIN_VALUE_LENGTH = 6;
const MAX_CACHED_RUNS = 64;

/**
 * The read-only structural vault surface keeps telemetry within its schemas-only package boundary.
 */
export interface VaultRunReader {
  /** List raw values owned by a run. */
  listRawValues(runId: Id): Promise<readonly string[]>;
  /** Return a monotonic version that changes when run values are added or purged. */
  version(runId: Id): Promise<number>;
}

const VaultRunViewOptionsSchema = z
  .object({
    minValueLength: z.number().int().min(1).optional(),
  })
  .strict();

/** Options for creating a cached read-only view of vault values. */
export type VaultRunViewOptions = z.infer<typeof VaultRunViewOptionsSchema>;

/**
 * A run's filtered vault values. JSON and Node inspection reveal counts only.
 */
export class RunValueSet {
  readonly values: readonly string[];

  constructor(
    readonly version: number,
    values: readonly string[],
    readonly skippedShort: number,
  ) {
    this.values = Object.freeze([...values]);
    Object.freeze(this);
  }

  /** Return metadata only, never the raw values. */
  toJSON(): {
    readonly version: number;
    readonly valueCount: number;
    readonly skippedShort: number;
  } {
    return {
      version: this.version,
      valueCount: this.values.length,
      skippedShort: this.skippedShort,
    };
  }

  /** Return a count-only representation for Node's inspection tools. */
  inspect(): string {
    return `RunValueSet ${JSON.stringify(this.toJSON())}`;
  }

  [inspect.custom](): string {
    return this.inspect();
  }
}

interface CachedRunValues {
  version: number;
  valueSet: RunValueSet;
}

/**
 * Cache each run's filtered vault values and refresh it when the vault version changes.
 */
export class VaultRunView {
  private readonly cache = new Map<string, CachedRunValues>();
  private readonly minValueLength: number;

  /**
   * Create the read-only view.
   * @param reader The vault's read-only value-list and version methods.
   * @param options Sentinel value filtering options.
   */
  constructor(
    private readonly reader: VaultRunReader,
    options: VaultRunViewOptions = {},
    private readonly scopeOf: (runId: Id) => Id = (runId) => runId,
  ) {
    this.minValueLength =
      VaultRunViewOptionsSchema.parse(options).minValueLength ?? DEFAULT_MIN_VALUE_LENGTH;
  }

  /**
   * Return cached values for a run, refreshing on a changed vault version.
   * @param runId Run identifier.
   */
  async valuesFor(runId: Id): Promise<RunValueSet> {
    const scopeId = this.scopeOf(runId);
    const version = await this.reader.version(scopeId);
    const cached = this.cache.get(scopeId);
    if (cached?.version === version) {
      this.touch(scopeId, cached);
      return cached.valueSet;
    }

    const values = await this.reader.listRawValues(scopeId);
    const uniqueValues = new Set<string>();
    let skippedShort = 0;
    for (const rawValue of values) {
      const value = rawValue.trim();
      if (value.length < this.minValueLength) {
        skippedShort += 1;
      } else {
        uniqueValues.add(value);
      }
    }

    const valueSet = new RunValueSet(version, [...uniqueValues], skippedShort);
    const newlySkippedShort = Math.max(0, skippedShort - (cached?.valueSet.skippedShort ?? 0));
    if (newlySkippedShort > 0) {
      countSkippedShortValues(newlySkippedShort);
    }
    this.touch(scopeId, { version, valueSet });
    this.evictOverflow();
    return valueSet;
  }

  /** Forget a completed run after its sentinel grace period. */
  forgetRun(runId: Id): void {
    this.cache.delete(this.scopeOf(runId));
  }

  private touch(runId: Id, cached: CachedRunValues): void {
    this.cache.delete(runId);
    this.cache.set(runId, cached);
  }

  private evictOverflow(): void {
    while (this.cache.size > MAX_CACHED_RUNS) {
      const oldestRunId = this.cache.keys().next().value;
      if (oldestRunId === undefined) {
        return;
      }
      this.cache.delete(oldestRunId);
    }
  }
}
