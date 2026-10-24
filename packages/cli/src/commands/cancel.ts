// SPDX-License-Identifier: Apache-2.0
import { HarnessError, Id, RunResultSchema } from "@rovinos/schemas";
import type { CommandModule } from "../command.js";
import { createCommandRuntime } from "../command.js";

class AlreadyTerminalError extends HarnessError {
  override readonly code = "run_already_terminal";

  constructor() {
    super("The run is already terminal.");
  }
}

/** Registers the `harness cancel` command. */
export const cancelCommand: CommandModule = {
  name: "cancel",
  /** Registers the `cancel` command. */
  register(program, context) {
    program
      .command("cancel")
      .description("Cancel a running or suspended run")
      .argument("<runId>", "run identifier")
      .action(async (value: string) => {
        const runId = Id.parse(value);
        const config = await context.loadConfig();
        const runtime = await createCommandRuntime(context, config);
        try {
          const result = await runtime.cancel(runId);
          if (result === "already_terminal") {
            throw new AlreadyTerminalError();
          }
          context.out.json(RunResultSchema, { runId, status: "cancelled" });
          context.out.print(`${runId}\n`);
        } finally {
          await runtime.close();
        }
      });
  },
};
