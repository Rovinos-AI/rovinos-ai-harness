// SPDX-License-Identifier: Apache-2.0
import { CompositeSecretResolver, loadConfig, type HarnessConfig } from "@harness/config";
import { HARNESS_VERSION } from "@harness/schemas";
import { emitKeysRotated } from "@harness/telemetry";
import { Command, CommanderError } from "commander";
import { dirname, resolve } from "node:path";
import type { CliContext, Clock, CommandModule } from "./command.js";
import { errorCodeOf, exitCodeForError, ExitCode } from "./exit-codes.js";
import { createOutput, type Output } from "./output.js";
import { createTerminalPrompt } from "./prompt.js";
import { serveCommand } from "./serve.js";
import { cancelCommand } from "./commands/cancel.js";
import { continueCommand } from "./commands/continue.js";
import { approvalsCommand } from "./commands/approvals.js";
import { contextCommand } from "./commands/context.js";
import { doctorCommand } from "./commands/doctor.js";
import { inspectCommand } from "./commands/inspect.js";
import { resumeCommand } from "./commands/resume.js";
import { runCommand } from "./commands/run.js";
import { keysCommand } from "./commands/keys.js";
import { policyCommand } from "./commands/policy.js";
import { serversCommand } from "./commands/servers.js";
import { storeCommand } from "./commands/store.js";
import { healthcheckCommand } from "./healthcheck.js";

/** Static command registry; later epics add their owned commands here. */
export const COMMANDS: CommandModule[] = [
  serveCommand,
  runCommand,
  resumeCommand,
  approvalsCommand,
  inspectCommand,
  cancelCommand,
  contextCommand,
  continueCommand,
  doctorCommand,
  keysCommand,
  policyCommand,
  serversCommand,
  storeCommand,
  healthcheckCommand,
];

const systemClock: Clock = { now: () => Date.now() };

/** Creates the CLI context with config loading, runtime composition, and output routing. */
export function createDefaultContext(program: Command, out: Output): CliContext {
  const secretResolver = new CompositeSecretResolver();
  return {
    loadConfig: (): Promise<HarnessConfig> => {
      const configPath = program.opts<{ config?: string }>().config;
      return configPath === undefined ? loadConfig() : loadConfig({ configPath });
    },
    out,
    clock: systemClock,
    secretResolver,
    interactive: createTerminalPrompt(process.stdin, out),
    createRuntime: async (config, overrides) => {
      const { createRuntime } = await import("@harness/core");
      return createRuntime(config, {
        ...overrides,
        onKeysWarning: (code) => {
          overrides?.onKeysWarning?.(code);
          out.error(code, "development_only_ephemeral_key");
        },
        roleConfigDirectory:
          overrides?.roleConfigDirectory ??
          dirname(
            resolve(
              program.opts<{ config?: string }>().config ??
                process.env.HARNESS_CONFIG ??
                "harness.config.yaml",
            ),
          ),
        secretResolver: overrides?.secretResolver ?? secretResolver,
      });
    },
    openKeyRotation: async (config, selection) => {
      const { openConfiguredKeyRotation } = await import("@harness/core");
      return openConfiguredKeyRotation(config, {
        ...selection,
        secretResolver,
      });
    },
    keyRotationLogger: emitKeysRotated,
  };
}

function createProgram(out: Output): Command {
  const program = new Command();
  program
    .name("harness")
    .description("Rovinos AI Harness command line interface")
    .version(HARNESS_VERSION, "-V, --version", "output version number")
    .option("-c, --config <path>", "path to harness configuration")
    .option("--json", "write command results as JSON")
    .option("--log-level <level>", "set the log level", "info")
    .configureOutput({
      writeOut: (text) => {
        out.print(text);
      },
      writeErr: () => undefined,
      outputError: () => undefined,
    })
    .exitOverride();
  return program;
}

function handleCommanderError(error: CommanderError, program: Command, out: Output): ExitCode {
  if (error.code === "commander.helpDisplayed" || error.code === "commander.version") {
    return ExitCode.ok;
  }
  if (error.code === "commander.unknownCommand") {
    program.outputHelp();
  }
  out.error("usage");
  return ExitCode.usage;
}

/**
 * Parses arguments and runs the registered harness command framework.
 *
 * @param argv - Arguments excluding the Node executable and script path.
 * @param context - Optional dependencies supplied by a caller or test.
 * @param commands - Command modules to register; defaults to the static registry.
 * @returns The stable process exit code for the command invocation.
 */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
  context?: CliContext,
  commands: readonly CommandModule[] = COMMANDS,
): Promise<ExitCode> {
  const output = context?.out ?? createOutput();
  const program = createProgram(output);
  const cliContext = context ?? createDefaultContext(program, output);
  output.setJsonMode(argv.includes("--json"));

  try {
    for (const command of commands) {
      command.register(program, cliContext);
    }
    if (argv.length === 0) {
      program.outputHelp();
    } else {
      await program.parseAsync([...argv], { from: "user" });
    }
    output.finalize();
    return ExitCode.ok;
  } catch (error) {
    if (error instanceof CommanderError) {
      return handleCommanderError(error, program, output);
    }
    const code = errorCodeOf(error);
    const hint =
      typeof error === "object" &&
      error !== null &&
      "hint" in error &&
      typeof error.hint === "string"
        ? error.hint
        : undefined;
    output.error(code, hint);
    return exitCodeForError(code);
  }
}
