// SPDX-License-Identifier: Apache-2.0
import { Id } from "@rovinos/schemas";
import { ExecSpecSchema } from "@rovinos/sandbox";
import type { GraderSpec } from "../schema.js";
import type { Grader, GradeContext } from "./types.js";
import { makeGradeResult } from "./types.js";

const DEFAULT_TIMEOUT_MS = 60_000;
type TestCommandSpec = Extract<GraderSpec, { type: "test_command" }>;

/**
 * Creates a grader that runs a shell-free command through the trial's sandbox backend.
 *
 * @param spec - Validated test-command grader specification.
 */
export function createTestCommandGrader(spec: TestCommandSpec): Grader {
  return {
    id: "test_command",
    async grade(ctx: GradeContext) {
      if (ctx.backend === undefined) {
        return makeGradeResult("test_command", false, "exit_nonzero");
      }
      if (ctx.result.runId === undefined) {
        return makeGradeResult("test_command", false, "exit_nonzero");
      }

      const parsed = ExecSpecSchema.parse({
        argv: [...spec.argv],
        timeoutMs: DEFAULT_TIMEOUT_MS,
        limits: { memoryMb: 512, pids: 64, outputBytes: 65_536, cpuSeconds: 60 },
      });
      try {
        const outcome = await ctx.backend.exec(
          Id.parse(ctx.result.runId),
          parsed,
          new AbortController().signal,
        );
        if (outcome.timedOut) {
          return makeGradeResult("test_command", false, "timeout");
        }
        const pass = outcome.exitCode === (spec.expectExit ?? 0);
        return makeGradeResult("test_command", pass, pass ? undefined : "exit_nonzero");
      } catch {
        return makeGradeResult("test_command", false, "exit_nonzero");
      }
    },
  };
}
