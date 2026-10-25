// SPDX-License-Identifier: Apache-2.0
import type { Runtime } from "@rovinos/core";
import type { HarnessConfig } from "@rovinos/config";
import { createOutput, ExitCode, main, type CliContext } from "@rovinos/cli/programmatic";

/** Run the public CLI against the runtime's persistent store and capture both output streams. */
export async function captureCliOutput(input: {
  readonly args: readonly string[];
  readonly config: HarnessConfig;
  readonly runtime: Runtime;
  readonly clock: { now(): number };
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}): Promise<void> {
  const stderr: string[] = [];
  const context: CliContext = {
    loadConfig: () => Promise.resolve(input.config),
    out: createOutput({
      stdout: input.stdout,
      stderr: (text) => {
        stderr.push(text);
        input.stderr(text);
      },
    }),
    clock: input.clock,
    createRuntime: () => Promise.resolve({ ...input.runtime, close: () => Promise.resolve() }),
  };
  const exitCode = await main(input.args, context);
  if (exitCode !== ExitCode.ok) {
    throw new Error(
      `The canary CLI command failed with exit code ${String(exitCode)}: ${stderr.join("").trim()}`,
    );
  }
}
