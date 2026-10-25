// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import {
  JsonValue,
  ToolSpecSchema,
  type Code as CodeType,
  type Id as IdType,
  type JsonValue as JsonValueType,
  type ToolSpec,
} from "@rovinos/schemas";
import {
  ExecLimitsSchema,
  ExecSpecSchema,
  MAX_EXEC_TIMEOUT_MS,
  SANDBOX_ENV_FORBIDDEN_CODE,
} from "./types.js";
import type { ExecLimits, SandboxBackend } from "./types.js";

/** Model-visible command fields; resource limits remain under host control. */
export const ExecToolInputSchema = ExecSpecSchema.pick({
  argv: true,
  cwd: true,
  env: true,
  stdin: true,
  timeoutMs: true,
});

/** Options required to construct the built-in execution tool. */
export interface SandboxExecToolOptions {
  /** Backend used for command execution. */
  readonly backend: SandboxBackend;
  /** Trusted per-execution resource limits, never model-controlled. */
  readonly limits: ExecLimits;
}

interface SandboxExecToolCall {
  readonly callId: IdType;
  readonly toolId: CodeType;
  readonly args: JsonValueType;
}

interface SandboxExecRunContext {
  readonly runId: IdType;
  readonly signal: AbortSignal;
}

interface SandboxExecToolDescription {
  readonly idempotent: boolean;
  readonly timeoutMs: number;
}

interface SandboxExecToolResult {
  readonly outcome: "ok" | "error";
  readonly result: JsonValueType;
  readonly errorCode?: CodeType;
}

const EXEC_TOOL_ID: CodeType = "sandbox.exec";
const EXEC_TOOL_SPEC: ToolSpec = ToolSpecSchema.parse({
  toolId: EXEC_TOOL_ID,
  description: "Run a shell-free command in the configured sandbox workspace.",
  inputSchema: JsonValue.parse(z.toJSONSchema(ExecToolInputSchema)),
});

/**
 * Exposes the `sandbox.exec` command as a ToolPort-compatible provider.
 *
 * Results are returned unchanged for the surrounding PII and output-offloading decorators.
 */
export class SandboxExecTool {
  readonly #backend: SandboxBackend;
  readonly #limits: ExecLimits;

  /**
   * Create the command tool using host-controlled resource limits.
   *
   * @param options - Backend and trusted limits for every command.
   */
  constructor(options: SandboxExecToolOptions) {
    this.#backend = options.backend;
    this.#limits = ExecLimitsSchema.parse(options.limits);
  }

  /** Return the non-idempotent execution metadata for this tool. */
  describe(toolId: CodeType): SandboxExecToolDescription | undefined {
    return toolId === EXEC_TOOL_ID
      ? { idempotent: false, timeoutMs: MAX_EXEC_TIMEOUT_MS }
      : undefined;
  }

  /** Advertise the strict input schema to model providers. */
  getToolSpecs(): readonly ToolSpec[] {
    return [EXEC_TOOL_SPEC];
  }

  /**
   * Validate and run one command, returning its output to the standard tool decorators.
   *
   * @param call - Tool call including the validated JSON argument value.
   * @param context - Active run and cancellation signal.
   * @returns Execution output or a closed error code.
   */
  async execute(
    call: SandboxExecToolCall,
    context: SandboxExecRunContext,
  ): Promise<SandboxExecToolResult> {
    if (call.toolId !== EXEC_TOOL_ID) {
      return { outcome: "error", errorCode: "sandbox_exec_unknown_tool", result: null };
    }
    const input = ExecToolInputSchema.safeParse(call.args);
    if (!input.success) {
      const errorCode = input.error.issues.some(
        (issue) => issue.message === SANDBOX_ENV_FORBIDDEN_CODE,
      )
        ? SANDBOX_ENV_FORBIDDEN_CODE
        : "sandbox_exec_invalid";
      return { outcome: "error", errorCode, result: null };
    }
    try {
      const result = await this.#backend.exec(
        context.runId,
        ExecSpecSchema.parse({ ...input.data, limits: this.#limits }),
        context.signal,
      );
      return {
        outcome: "ok",
        result: JsonValue.parse({
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          truncated: result.truncated,
          timedOut: result.timedOut,
        }),
      };
    } catch {
      return { outcome: "error", errorCode: "sandbox_exec_failed", result: null };
    }
  }
}
