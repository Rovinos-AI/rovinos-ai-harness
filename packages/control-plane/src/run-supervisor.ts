// SPDX-License-Identifier: Apache-2.0
import { Code, Id } from "@harness/schemas";
import { ActiveRuns, activeRuns } from "@harness/telemetry";
import { z } from "zod";
import type { ResumeRunOutput } from "./schemas.js";

const RunSupervisorOptionsSchema = z
  .object({
    maxConcurrentRuns: z.number().int().positive().default(2),
  })
  .strict();

/** Dependencies for supervising in-process run resumes. */
export interface RunSupervisorOptions {
  readonly maxConcurrentRuns?: number;
  readonly resumeRun?: (runId: Id, signal: AbortSignal) => Promise<unknown>;
  readonly activeRuns?: Pick<ActiveRuns, "register">;
}

/** Starts resumptions asynchronously and cooperatively cancels locally supervised runs. */
export class RunSupervisor {
  private readonly active = new Map<Id, AbortController>();
  private readonly maxConcurrentRuns: number;
  private readonly resumeRun: RunSupervisorOptions["resumeRun"];
  private readonly activeRuns: Pick<ActiveRuns, "register">;

  /** Creates a supervisor with a bounded number of concurrent resumptions. */
  constructor(options: RunSupervisorOptions) {
    this.maxConcurrentRuns = RunSupervisorOptionsSchema.parse({
      maxConcurrentRuns: options.maxConcurrentRuns,
    }).maxConcurrentRuns;
    this.resumeRun = options.resumeRun;
    this.activeRuns = options.activeRuns ?? activeRuns;
  }

  /** Queues a resume and returns without waiting for the run to finish. */
  start(runId: Id): ResumeRunOutput {
    Id.parse(runId);
    if (this.resumeRun === undefined) {
      return { started: false, code: Code.parse("control_plane_runtime_unavailable") };
    }
    if (this.active.has(runId)) {
      return { started: false, code: Code.parse("resume_conflict") };
    }
    if (this.active.size >= this.maxConcurrentRuns) {
      return { started: false, code: Code.parse("capacity_exceeded") };
    }

    const controller = new AbortController();
    this.active.set(runId, controller);
    this.activeRuns.register(runId);
    void Promise.resolve()
      .then(() => this.resumeRun?.(runId, controller.signal))
      .catch(() => undefined)
      .finally(() => {
        this.active.delete(runId);
      });
    return { started: true };
  }

  /** Aborts a locally supervised resume if one is active. */
  abort(runId: Id): boolean {
    const controller = this.active.get(runId);
    if (controller === undefined) {
      return false;
    }
    controller.abort();
    return true;
  }

  /** Reports whether a resume is currently active for the run. */
  isActive(runId: Id): boolean {
    return this.active.has(runId);
  }
}
