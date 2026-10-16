// SPDX-License-Identifier: Apache-2.0
import {
  CompositeSecretResolver,
  EnvSecretResolver,
  FileSecretResolver,
  getConfigSecretRefs,
  type HarnessConfig,
} from "@harness/config";
import { createPresidioReachableCheck } from "@harness/pii";
import { createServersReachableChecks } from "@harness/mcp";
import { Code, DoctorResultsSchema, HarnessError } from "@harness/schemas";
import { LocalKeyProvider, LocalKeyProviderError } from "@harness/vault";
import type { DoctorCheck, DoctorContext, RuntimeConfig } from "@harness/core";
import type { CommandModule } from "../command.js";

class DoctorChecksFailedError extends HarnessError {
  override readonly code = "doctor_failed";

  constructor() {
    super("One or more doctor checks failed.");
  }
}

function keysConfiguredCheck(
  config: RuntimeConfig | undefined,
  env: Readonly<Record<string, string | undefined>>,
): DoctorCheck {
  return {
    id: "keys_configured",
    title: "Encryption keys",
    run: async (ctx) => {
      if (config === undefined) {
        return { status: "ok", code: "keys_configured" };
      }
      if (config.keys === undefined) {
        return env.NODE_ENV === "production"
          ? { status: "fail", code: "key_config_required" }
          : { status: "warn", code: "keys_ephemeral" };
      }
      const provider = new LocalKeyProvider({
        config: config.keys,
        secretResolver: new CompositeSecretResolver({
          env: new EnvSecretResolver(env),
          file: new FileSecretResolver(),
        }),
        env,
        onWarning: () => undefined,
      });
      try {
        for (const { id } of config.keys.keys) {
          if (ctx.signal?.aborted === true) {
            return { status: "fail", code: "check_timeout" };
          }
          try {
            await provider.getKey(id);
          } catch (error) {
            const parsedCode =
              error instanceof LocalKeyProviderError ? Code.safeParse(error.code) : undefined;
            return {
              status: "fail",
              code: parsedCode?.success === true ? parsedCode.data : "key_secret_unavailable",
              detail: Code.parse(id),
            };
          }
        }
        return { status: "ok", code: "keys_configured" };
      } finally {
        provider.dispose();
      }
    },
  };
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
          let configErrorCode: string | undefined;
          try {
            config = await context.loadConfig();
          } catch (error) {
            config = undefined;
            if (error instanceof HarnessError) {
              const parsedCode = Code.safeParse(error.code);
              if (parsedCode.success) {
                configErrorCode = parsedCode.data;
              }
            }
          }
          const env = process.env;
          const core = await import("@harness/core");
          const envResolver = new EnvSecretResolver(env);
          const secretResolver = new CompositeSecretResolver({
            env: envResolver,
            file: new FileSecretResolver(),
          });
          const doctorContext: DoctorContext = {
            config,
            ...(configErrorCode === undefined ? {} : { configErrorCode }),
            secretRefs: config === undefined ? [] : getConfigSecretRefs(config),
            env,
            dataDir: core.resolveDataDir(env),
            resolveSecret: async (ref, signal) => {
              let fileWarning: "secret_file_permissions" | undefined;
              const resolver = new CompositeSecretResolver({
                env: envResolver,
                file: new FileSecretResolver({
                  onWarning: (code) => {
                    fileWarning = code;
                  },
                }),
              });
              await resolver.resolve(ref, signal);
              return fileWarning;
            },
          };
          const presidioChecks =
            config?.pii.presidio === undefined
              ? []
              : [createPresidioReachableCheck(config.pii.presidio)];
          const defaultChecks = [
            ...core.doctorChecks(),
            keysConfiguredCheck(config, env),
            ...presidioChecks,
            ...createServersReachableChecks(config?.servers ?? [], {
              resolveSecret: async (ref, signal) => {
                return (await secretResolver.resolve(ref, signal)).reveal();
              },
              env,
            }),
          ];
          const results = await core.runDoctor(doctorContext, checks ?? defaultChecks);
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
