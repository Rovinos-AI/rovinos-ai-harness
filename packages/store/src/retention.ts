// SPDX-License-Identifier: Apache-2.0
import {
  StoreRetentionConfigSchema,
  type Code,
  type Id,
  type StoreRetentionConfig,
} from "@harness/schemas";
import type { Clock, EventStore, RunSummary } from "./types.js";

const RUN_LIST_BATCH_SIZE = 100;
const MILLIS_PER_DAY = 86_400_000;
const RUN_ID_FIELD = "harness.run_id" satisfies Code;

/** Safe metadata fields accepted by the retention logger. */
export type RetentionLogFields = Readonly<Record<string, Id | number | boolean>>;

/** Metadata-only logger used by the retention job. */
export interface RetentionLogger {
  /** Record an informational event with allowlisted metadata. */
  info(event: Code, fields: RetentionLogFields): void;
  /** Record an error event with allowlisted metadata. */
  error(event: Code, fields: RetentionLogFields): void;
}

/** Input to {@link purgeExpiredRuns}. */
export interface PurgeExpiredRunsOptions {
  /** Store whose terminal runs will be considered. */
  store: EventStore;
  /** Clock used to calculate retention cutoffs. */
  clock: Clock;
  /** Validated retention settings. */
  policy: StoreRetentionConfig;
  /** Purge associated vault data after a run has been deleted. */
  onRunPurged?: (runId: Id) => Promise<void>;
  /** When true, count eligible runs without changing the store or vault. */
  dryRun: boolean;
  /** Optional metadata-only logger. */
  logger?: RetentionLogger;
}

/** Counts returned by {@link purgeExpiredRuns}. */
export interface PurgeExpiredRunsResult {
  /** Terminal and active runs examined. */
  examined: number;
  /** Runs deleted from the store. */
  purged: number;
  /** Running and suspended runs left untouched. */
  skippedActive: number;
}

const noopLogger: RetentionLogger = {
  info: () => undefined,
  error: () => undefined,
};

/**
 * Delete terminal runs older than their configured retention windows.
 *
 * @param options Store, clock, retention policy, and side-effect hooks.
 * @returns Counts of examined, deleted, and skipped active runs.
 */
export async function purgeExpiredRuns(
  options: PurgeExpiredRunsOptions,
): Promise<PurgeExpiredRunsResult> {
  const policy = StoreRetentionConfigSchema.parse(options.policy);
  const cutoff = options.clock.now();
  const logger = options.logger ?? noopLogger;
  const result: PurgeExpiredRunsResult = { examined: 0, purged: 0, skippedActive: 0 };

  async function considerRun(run: RunSummary, status: RunSummary["status"]): Promise<void> {
    result.examined += 1;
    if (status === "running" || status === "suspended") {
      result.skippedActive += 1;
      return;
    }
    const retentionDays = status === "completed" ? policy.completedRunsDays : policy.failedRunsDays;
    if (run.lastTs >= cutoff - retentionDays * MILLIS_PER_DAY || options.dryRun) {
      return;
    }
    const deletedEvents = await options.store.deleteRun(run.runId);
    if (deletedEvents === 0) {
      return;
    }
    result.purged += 1;
    logger.info("run_purged", { [RUN_ID_FIELD]: run.runId });
    if (options.onRunPurged !== undefined) {
      try {
        await options.onRunPurged(run.runId);
      } catch {
        logger.error("run_purge_hook_failed", { [RUN_ID_FIELD]: run.runId });
      }
    }
  }

  async function listStatus(status: RunSummary["status"]): Promise<void> {
    let cursor: string | undefined;
    let pendingCursorRun: RunSummary | undefined;
    do {
      const page = await options.store.listRuns({
        status,
        limit: RUN_LIST_BATCH_SIZE,
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (pendingCursorRun !== undefined) {
        await considerRun(pendingCursorRun, status);
      }
      const anchorIndex = page.nextCursor === undefined ? page.runs.length : page.runs.length - 1;
      for (const run of page.runs.slice(0, anchorIndex)) {
        await considerRun(run, status);
      }
      pendingCursorRun = page.nextCursor === undefined ? undefined : page.runs.at(-1);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
  }

  for (const status of ["completed", "failed", "cancelled", "running", "suspended"] as const) {
    await listStatus(status);
  }
  return result;
}
