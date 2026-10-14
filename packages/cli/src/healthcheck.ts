// SPDX-License-Identifier: Apache-2.0
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { z } from "zod";
import type { CommandModule } from "./command.js";

const HealthcheckResultSchema = z.object({ status: z.literal("healthy") }).strict();

/** Registers the local-state-only `harness healthcheck` command. */
export const healthcheckCommand: CommandModule = {
  name: "healthcheck",
  register(program, context) {
    program
      .command("healthcheck")
      .description("Check local harness state without network calls")
      .action(async () => {
        const core = await import("@harness/core");
        const dataDir = core.resolveDataDir(process.env);
        const dataDirs = new Set([dataDir, process.env.HARNESS_VAULT_DATA_DIR ?? dataDir]);
        for (const directory of dataDirs) {
          await access(directory, constants.R_OK | constants.W_OK);
          if (!(await stat(directory)).isDirectory()) {
            throw new Error("Harness state is not a directory.");
          }
        }
        context.out.json(HealthcheckResultSchema, { status: "healthy" });
        if (program.opts<{ json?: boolean }>().json !== true) {
          context.out.print("healthy\n");
        }
      });
  },
};
