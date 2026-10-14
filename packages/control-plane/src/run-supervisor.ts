// SPDX-License-Identifier: Apache-2.0
import { Code, Id } from "@harness/schemas";
import { activeRuns } from "@harness/telemetry";
import type { ActiveRuns } from "@harness/telemetry";
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
  readonly resumeRun?: (
    runId: Id,
    signal: AbortSignal,
    onClaimed: () => void,
  ) => Promise<unknown>;
  readonly activeRuns?: Pick<ActiveRuns, "register" | "terminate">;
}

/** Starts resumptions asynchronously and cooperatively cancels locally supervised runs. */
export class RunSupervisor {
  private readonly active = new Map<Id, AbortController>();
  private readonly maxConcurrentRuns: number;
  private readonly resumeRun: RunSupervisorOptions["resumeRun"];
  private readonly activeRuns: Pick<ActiveRuns, "register" | "terminate">;

  /** Creates a supervisor with a bounded number of concurrent resumptions. */
  constructor(options: RunSupervisorOptions) {
    this.maxConcurrentRuns = RunSupervisorOptionsSchema.parse({
      maxConcurrentRuns: options.maxConcurrentRuns,
    }).maxConcurrentRuns;
    this.resumeRun = options.resumeRun;
    this.activeRuns = options.activeRuns ?? activeRuns;
  }

  /** Queues a resume and returns without waiting for the run to finish. */
  start(runId: Id): Promise<ResumeRunOutput> {
    Id.parse(runId);
    if (this.resumeRun === undefined) {
      return Promise.resolve({
        started: false,
        code: Code.parse("control_plane_runtime_unavailable"),
      });
    }
    if (this.active.has(runId)) {
      return Promise.resolve({ started: false, code: Code.parse("resume_conflict") });
    }
    if (this.active.size >= this.maxConcurrentRuns) {
      return Promise.resolve({ started: false, code: Code.parse("capacity_exceeded") });
    }

    const controller = new AbortController();
    this.active.set(runId, controller);
    this.activeRuns.register(runId);
    let claimed = false;
    let resolveStarted: (result: ResumeRunOutput) => void = () => undefined;
    const started = new Promise<ResumeRunOutput>((resolve) => {
      resolveStarted = resolve;
    });
    const onClaimed = (): void => {
      if (!claimed) {
        claimed = true;
        resolveStarted({ started: true });
      }
    };
    void Promise.resolve()
      .then(() => this.resumeRun?.(runId, controller.signal, onClaimed))
      .then((result) => {
        if (!claimed) {
          onClaimed();
        }
        if (isTerminalResumeResult(result)) {
          this.activeRuns.terminate(runId);
        }
      })
      .catch((error: unknown) => {
        if (!claimed) {
          resolveStarted({ started: false, code: resumeErrorCode(error) });
        }
      })
      .finally(() => {
        this.active.delete(runId);
      });
    return started;
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

function resumeErrorCode(error: unknown): Code {
  if (typeof error === "object" && error !== null && "code" in error) {
    const parsed = Code.safeParse(error.code);
    if (parsed.success) {
      return parsed.data;
    }
  }
  return Code.parse("resume_failed");
}

function isTerminalResumeResult(result: unknown): boolean {
  return z
    .object({ status: z.enum(["completed", "failed", "cancelled"]) })
    .passthrough()
    .safeParse(result).success;
}
