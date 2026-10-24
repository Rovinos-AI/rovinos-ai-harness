// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import type { Id } from "@rovinos/schemas";

/** Maximum timeout accepted by the execution contract and built-in tool. */
export const MAX_EXEC_TIMEOUT_MS = 300_000;

/** Code reported when a command requests an unsafe environment variable. */
export const SANDBOX_ENV_FORBIDDEN_CODE = "sandbox_env_forbidden";

const FORBIDDEN_ENVIRONMENT_KEYS = new Set([
  "PATH",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "BASH_ENV",
  "ENV",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PYTHONHOME",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "PYTHONINSPECT",
  "PERL5OPT",
  "PERL5LIB",
  "RUBYOPT",
  "RUBYLIB",
  "JAVA_TOOL_OPTIONS",
  "JDK_JAVA_OPTIONS",
  "_JAVA_OPTIONS",
  "PHP_INI_SCAN_DIR",
  "PHPRC",
]);

/** Timeout bound shared by request validation and host backend configuration. */
export const ExecTimeoutMsSchema = z.number().int().positive().max(MAX_EXEC_TIMEOUT_MS);

/**
 * Child variables are opt-in; loader and interpreter startup controls are forbidden.
 * Startup denylist: BASH_ENV, ENV, NODE_OPTIONS, NODE_PATH, PYTHONHOME, PYTHONPATH,
 * PYTHONSTARTUP, PYTHONINSPECT, PERL5OPT, PERL5LIB, RUBYOPT, RUBYLIB,
 * JAVA_TOOL_OPTIONS, JDK_JAVA_OPTIONS, _JAVA_OPTIONS, PHP_INI_SCAN_DIR, and PHPRC.
 */
const EnvironmentSchema = z
  .record(z.string().regex(/^(?:[A-Z][A-Z0-9_]{0,63}|_JAVA_OPTIONS)$/u), z.string())
  .superRefine((environment, context) => {
    if (Object.keys(environment).length > 32) {
      context.addIssue({
        code: "custom",
        message: "At most 32 environment variables are allowed.",
      });
    }
    for (const key of Object.keys(environment)) {
      if (FORBIDDEN_ENVIRONMENT_KEYS.has(key) || key.startsWith("LD_") || key.startsWith("DYLD_")) {
        context.addIssue({
          code: "custom",
          message: SANDBOX_ENV_FORBIDDEN_CODE,
          path: [key],
        });
      }
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

/**
 * A shell-free command request scoped to a workspace.
 *
 * `limits.outputBytes` also sets the file-size resource limit on files written by the
 * command until per-run workspace quotas are implemented in task 19.5.
 */
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
    timeoutMs: ExecTimeoutMsSchema,
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

/** Supplies deterministic time measurements and timeout scheduling to a sandbox backend. */
export interface Clock {
  /** Returns the current time in epoch milliseconds. */
  now(): number;

  /**
   * Schedules a callback and returns a function that cancels it.
   *
   * @param callback - Callback invoked after the delay.
   * @param delayMs - Delay in milliseconds.
   * @returns A function that cancels the scheduled callback.
   */
  schedule(callback: () => void, delayMs: number): () => void;
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
  /** Acquires a runner-wide lease before a run starts, when the backend supports leases. */
  acquireLease?(runId: Id, ttlMs?: number): Promise<void>;
  /** Releases a runner-wide lease after a run suspends or reaches a terminal state. */
  releaseLease?(runId: Id): Promise<void>;
  /** Releases backend-owned resources when its runtime closes. */
  close?(): Promise<void>;
}
