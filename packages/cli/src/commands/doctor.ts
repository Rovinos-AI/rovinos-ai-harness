// SPDX-License-Identifier: Apache-2.0
import {
  CompositeSecretResolver,
  EnvSecretResolver,
  FileSecretResolver,
  type HarnessConfig,
} from "@harness/config";
import { DoctorResultsSchema, HarnessError } from "@harness/schemas";
import type { DoctorCheck, DoctorContext } from "@harness/core";
import type { CommandModule } from "../command.js";

class DoctorChecksFailedError extends HarnessError {
  override readonly code = "doctor_failed";

  constructor() {
    super("One or more doctor checks failed.");
  }
}

/**
 * Creates the `harness doctor` command.
 *
 * @param checks - Optional check list used by command tests or embedding callers.
 * @returns A command module that validates configuration and reports safe diagnostics.
 */
export function createDoctorCommand(checks?: readonly DoctorCheck[]): CommandModule {
  return {
    name: "doctor",
    register(program, context) {
      program
        .command("doctor")
        .description("Check the local harness environment")
        .action(async () => {
          let config: HarnessConfig | undefined;
          try {
            config = await context.loadConfig();
          } catch {
            config = undefined;
          }
          const env = process.env;
          const envResolver = new EnvSecretResolver(env);
          const doctorContext: DoctorContext = {
            config,
            env,
            dataDir: env.HARNESS_DATA_DIR ?? process.cwd(),
            resolveSecret: async (ref) => {
              let fileWarning: "secret_file_permissions" | undefined;
              const resolver = new CompositeSecretResolver({
                env: envResolver,
                file: new FileSecretResolver({
                  onWarning: (code) => {
                    fileWarning = code;
                  },
                }),
              });
              await resolver.resolve(ref);
              return fileWarning;
            },
          };
          const core = await import("@harness/core");
          const results = await core.runDoctor(doctorContext, checks ?? core.DOCTOR_CHECKS);
          if (program.opts<{ json?: boolean }>().json === true) {
            context.out.json(DoctorResultsSchema, results);
          } else {
            context.out.table([
              ["id", "status", "code"],
              ...results.map(({ id, status, code }) => [id, status, code]),
            ]);
          }
          if (results.some(({ status }) => status === "fail")) {
            throw new DoctorChecksFailedError();
          }
        });
    },
  };
}

/** The default command registered by the CLI. */
export const doctorCommand = createDoctorCommand();
