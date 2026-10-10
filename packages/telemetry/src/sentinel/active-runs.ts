// SPDX-License-Identifier: Apache-2.0
import type { Id } from "@harness/schemas";
import { z } from "zod";

const ActiveRunsOptionsSchema = z
  .object({
    graceMs: z.number().int().nonnegative().default(300_000),
  })
  .strict();

/** Options for active-run retention. */
export interface ActiveRunsOptions {
  readonly graceMs?: number;
  readonly now?: () => number;
}

/** Tracks runs in this process and retains finished runs for the sentinel grace period. */
export class ActiveRuns {
  private readonly runs = new Map<Id, number | undefined>();
  private readonly graceMs: number;
  private readonly now: () => number;

  /** @param options Grace period and clock used to expire finished runs. */
  constructor(options: ActiveRunsOptions = {}) {
    const parsed = ActiveRunsOptionsSchema.parse({ graceMs: options.graceMs });
    this.graceMs = parsed.graceMs;
    this.now = options.now ?? Date.now;
  }

  /** Register a run that has started in this process. */
  register(runId: Id): void {
    this.runs.set(runId, undefined);
  }

  /** Mark a run finished while retaining it for the configured grace period. */
  terminate(runId: Id): void {
    if (this.runs.has(runId)) {
      this.runs.set(runId, this.now());
    }
  }

  /** Return active and grace-period run IDs, expiring old entries. */
  runIds(): readonly Id[] {
    const now = this.now();
    for (const [runId, terminatedAt] of this.runs) {
      if (terminatedAt !== undefined && now - terminatedAt >= this.graceMs) {
        this.runs.delete(runId);
      }
    }
    return [...this.runs.keys()];
  }
}

/** Process-wide run registry shared by run loops and telemetry pipelines. */
export const activeRuns = new ActiveRuns();
