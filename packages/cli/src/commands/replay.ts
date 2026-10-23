// SPDX-License-Identifier: Apache-2.0
import { resolveRun, ReplayInputError } from "@harness/replay";
import { Id } from "@harness/schemas";
import { z } from "zod";
import type { CommandModule } from "../command.js";
import { createCommandRuntime } from "../command.js";

const ReplayCommandResultSchema = z
  .object({
    rootRunId: Id,
    runs: z
      .object({
        runId: Id,
        role: z.enum(["root", "subagent"]),
        parentRunId: Id.optional(),
      })
      .strict()
      .array(),
  })
  .strict();

/** Registers the `harness replay` run-resolution command. */
export const replayCommand: CommandModule = {
  name: "replay",
  /** Registers replay selectors and returns only resolved run metadata. */
  register(program, context) {
    program
      .command("replay")
      .description("Resolve a recorded run by run id or trace id")
      .option("--run <id>", "run identifier")
      .option("--trace <id>", "trace identifier or W3C traceparent")
      .option("--strict", "fail on any replay difference")
      .option("--golden <file>", "golden baseline file")
      .option("--update-baseline", "update the golden baseline")
      .option("--report <path>", "write a replay report")
      .action(
        async (options: {
          readonly run?: string;
          readonly trace?: string;
          readonly strict?: boolean;
          readonly golden?: string;
          readonly updateBaseline?: boolean;
          readonly report?: string;
        }) => {
          if ((options.run === undefined) === (options.trace === undefined)) {
            throw new ReplayInputError();
          }
          const config = await context.loadConfig();
          const runtime = await createCommandRuntime(context, config);
          try {
            const resolved = await resolveRun({
              store: runtime.store,
              ...(options.run === undefined ? {} : { runId: options.run }),
              ...(options.trace === undefined ? {} : { traceId: options.trace }),
            });
            const result = ReplayCommandResultSchema.parse({
              rootRunId: resolved.rootRunId,
              runs: resolved.runs.map(({ runId, role, parentRunId }) => ({
                runId,
                role,
                ...(parentRunId === undefined ? {} : { parentRunId }),
              })),
            });
            if (program.optsWithGlobals<{ json?: boolean }>().json === true) {
              context.out.json(ReplayCommandResultSchema, result);
            } else {
              context.out.table([
                ["role", "runId"],
                ...result.runs.map(({ role, runId }) => [role, runId]),
              ]);
            }
          } finally {
            await runtime.close();
          }
        },
      );
  },
};
