// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import type { Id } from "@harness/schemas";

const EnvironmentSchema = z
  .record(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/u), z.string())
  .superRefine((environment, context) => {
    if (Object.keys(environment).length > 32) {
      context.addIssue({
        code: "custom",
        message: "At most 32 environment variables are allowed.",
      });
    }
  });

/** Resource limits that execution backends must apply to every request. */
export const ExecLimitsSchema = z
  .object({
    memoryMb: z.number().int().positive(),
    pids: z.number().int().positive(),
    outputBytes: z.number().int().nonnegative(),
    cpuSeconds: z.number().int().positive(),
  })
  .strict();

/** Inferred execution resource limits. */
export type ExecLimits = z.infer<typeof ExecLimitsSchema>;

/** A shell-free command request scoped to a workspace. */
export const ExecSpecSchema = z
  .object({
    argv: z
      .array(z.string().max(4096))
      .min(1)
      .max(64)
      .refine((argv) => argv[0] !== undefined && argv[0].length > 0),
    cwd: z.string().optional(),
    env: EnvironmentSchema.optional(),
    stdin: z
      .string()
      .refine((value) => new TextEncoder().encode(value).byteLength <= 1_048_576)
      .optional(),
    timeoutMs: z.number().int().positive(),
    limits: ExecLimitsSchema,
  })
  .strict();

/** Inferred input to a sandbox backend. */
export type ExecSpec = z.infer<typeof ExecSpecSchema>;

/** The bounded process output and termination metadata returned by a backend. */
export const ExecResultSchema = z
  .object({
    exitCode: z.number().int().nonnegative().nullable(),
    signal: z
      .string()
      .regex(/^SIG[A-Z0-9]+$/u)
      .optional(),
    stdout: z.string(),
    stderr: z.string(),
    stdoutBytes: z.number().int().nonnegative(),
    stderrBytes: z.number().int().nonnegative(),
    truncated: z.boolean(),
    timedOut: z.boolean(),
    durationMs: z.number().int().nonnegative(),
  })
  .strict();

/** Inferred output of a sandbox backend execution. */
export type ExecResult = z.infer<typeof ExecResultSchema>;

/** Supplies deterministic time measurements to a sandbox backend. */
export interface Clock {
  /** Returns the current time in epoch milliseconds. */
  now(): number;
}

/** Port implemented by local and remote sandbox execution backends. */
export interface SandboxBackend {
  /**
   * Executes a validated argv request for one run.
   *
   * @param runId - Run owning the execution.
   * @param spec - Validated command and resource limits.
   * @param signal - Cancellation signal that terminates the execution.
   * @returns Exit status, bounded output, and timing metadata.
   */
  exec(runId: Id, spec: ExecSpec, signal: AbortSignal): Promise<ExecResult>;
}
