// SPDX-License-Identifier: Apache-2.0
import { HarnessError, Id, RunResultSchema } from "@harness/schemas";
import type { CommandModule } from "../command.js";
import { createCommandRuntime } from "../command.js";
import { readFakeModel } from "./run.js";

class ResumeStatusError extends HarnessError {
  override readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

/** Throws the coded error that maps a non-completed resume status to its exit code. */
export function assertResumeStatus(
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
  /** Registers the `resume` command. */
  register(program, context) {
    program
      .command("resume")
      .description("Resume an interrupted or suspended run")
      .argument("<runId>", "run identifier")
      .option("--fake-model <script.json>", "JSON array of scripted model completions")
      .action(async (value: string, options: { readonly fakeModel?: string }) => {
        const runId = Id.parse(value);
        const config = await context.loadConfig();
        const model =
          options.fakeModel === undefined ? undefined : await readFakeModel(options.fakeModel);
        const runtime = await createCommandRuntime(
          context,
          config,
          model === undefined ? undefined : { model },
        );
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
