// SPDX-License-Identifier: Apache-2.0
import { loadConfig, type HarnessConfig } from "@harness/config";
import { HARNESS_VERSION } from "@harness/schemas";
import { Command, CommanderError } from "commander";
import type { CliContext, Clock, CommandModule } from "./command.js";
import { errorCodeOf, exitCodeForError, ExitCode } from "./exit-codes.js";
import { createOutput, type Output } from "./output.js";

/** Commands are added by the tasks that own them; none are registered yet. */
export const COMMANDS: CommandModule[] = [];

const systemClock: Clock = { now: () => Date.now() };

function createDefaultContext(program: Command, out: Output): CliContext {
  return {
    loadConfig: (): Promise<HarnessConfig> => {
      const configPath = program.opts<{ config?: string }>().config;
      return configPath === undefined ? loadConfig() : loadConfig({ configPath });
    },
    out,
    clock: systemClock,
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
    await program.parseAsync([...argv], { from: "user" });
    return ExitCode.ok;
  } catch (error) {
    if (error instanceof CommanderError) {
      return handleCommanderError(error, program, output);
    }
    const code = errorCodeOf(error);
    output.error(code);
    return exitCodeForError(code);
  }
}
