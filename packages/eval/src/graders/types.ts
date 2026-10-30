// SPDX-License-Identifier: Apache-2.0
import { Code } from "@rovinos/schemas";
import type { Event } from "@rovinos/schemas";
import type { ValidateWithTokensOptions } from "@rovinos/pii";
import type { SandboxBackend } from "@rovinos/sandbox";
import { z } from "zod";
import type { TrialResult } from "../trial.js";
import type { CanarySink } from "../canary.js";

/** Metadata-only result returned by every grader. */
export const GradeResultSchema = z
  .object({
    graderId: Code,
    pass: z.boolean(),
    score: z.number().min(0).max(1),
    codes: z.array(Code),
    counts: z.record(Code, z.number().int().nonnegative()).optional(),
  })
  .strict();

/** Inferred metadata-only grader result. */
export type GradeResult = z.infer<typeof GradeResultSchema>;

/** Trial artifacts and optional capabilities required by deterministic graders. */
export interface GradeContext {
  /** Metadata-only outcome returned by the trial executor. */
  readonly result: TrialResult;
  /** Ordered event log, when a grader needs to inspect model output. */
  readonly events?: readonly Event[];
  /** Backend already scoped to this trial's workspace. */
  readonly backend?: SandboxBackend;
  /** Audited token resolution used only when schema validation is configured for tokens. */
  readonly tokenValidation?: Omit<ValidateWithTokensOptions, "runId">;
  /** In-memory exporter content or collector output captured for privacy grading. */
  readonly telemetry?: readonly CanarySink[];
  /** Captured process output; content is never copied into grade results. */
  readonly logs?: readonly CanarySink[];
}

/** Deterministic grader over one trial's artifacts. */
export interface Grader {
  /** Stable identifier recorded in metadata-only grade results. */
  readonly id: z.infer<typeof Code>;
  /** Grades the supplied trial artifacts and bounded execution capabilities. */
  grade(ctx: GradeContext): Promise<GradeResult>;
}

/** Stable error for a grader whose required execution context is unavailable. */
/** Builds a validated result without retaining grader input or process output. */
export function makeGradeResult(graderId: string, pass: boolean, code?: string): GradeResult {
  const codes = code === undefined ? [] : [Code.parse(code)];
  return GradeResultSchema.parse({
    graderId: Code.parse(graderId),
    pass,
    score: pass ? 1 : 0,
    codes,
    ...(code === undefined ? {} : { counts: { [code]: 1 } }),
  });
}
