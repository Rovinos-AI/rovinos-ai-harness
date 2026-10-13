// SPDX-License-Identifier: Apache-2.0

/** Runs a CLI command with supplied arguments and an optional programmatic context. */
export { main } from "./main.js";

/** Creates the default CLI context with config loading and runtime composition. */
export { createDefaultContext } from "./main.js";

/** Creates the CLI output router for standard output and error. */
export { createOutput } from "./output.js";

/** Stable exit codes returned by {@link main}. */
export { ExitCode } from "./exit-codes.js";

/** Dependencies shared by CLI commands and injectable by programmatic callers. */
export type { CliContext } from "./command.js";
