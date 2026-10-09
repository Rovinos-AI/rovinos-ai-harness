// SPDX-License-Identifier: Apache-2.0
import { HarnessError, Id, RunResultSchema } from "@harness/schemas";
import type { CommandModule } from "../command.js";
import { createCommandRuntime } from "../command.js";

class ResumeStatusError extends HarnessError {
  override readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

function assertResumeStatus(
  status: "completed" | "failed" | "running" | "suspended" | "pending" | "cancelled",
  events: readonly { readonly type: string }[],
): void {
  if (status === "suspended") {
    throw new ResumeStatusError("suspended");
  }
  if (status === "failed") {
    throw new ResumeStatusError(
      events.some((event) => event.type === "budget_exceeded") ? "budget_exceeded" : "run_failed",
    );
  }
  if (status !== "completed") {
    throw new ResumeStatusError("run_failed");
  }
}

/** Registers the `harness resume` command. */
export const resumeCommand: CommandModule = {
  name: "resume",
  register(program, context) {
    program
      .command("resume")
      .description("Resume an interrupted or suspended run")
      .argument("<runId>", "run identifier")
      .action(async (value: string) => {
        const runId = Id.parse(value);
        const config = await context.loadConfig();
        const runtime = await createCommandRuntime(context, config);
        try {
          const result = await runtime.resume(runId);
          const output = { runId, status: result.status };
          context.out.json(RunResultSchema, output);
          context.out.print(`${runId}\n`);
          assertResumeStatus(result.status, result.events);
        } finally {
          await runtime.close();
        }
      });
  },
};
