// SPDX-License-Identifier: Apache-2.0
import type { Command } from "commander";
import type { HarnessConfig } from "@harness/config";
import type { Runtime, RuntimeOverrides } from "@harness/core";
import type { Output } from "./output.js";

/** A clock interface injected into every CLI command. */
export interface Clock {
  /** Returns the current time as epoch milliseconds. */
  now(): number;
}

/** Dependencies shared by every registered CLI command. */
export interface CliContext {
  /** Loads the validated harness configuration. */
  loadConfig(): Promise<HarnessConfig>;
  /** Writes human, JSON, and safe error output. */
  out: Output;
  /** Provides the current time without direct clock access in commands. */
  clock: Clock;
  /** Creates a composed run-loop runtime, optionally replacing its ports. */
  createRuntime?(config: HarnessConfig, overrides?: RuntimeOverrides): Promise<Runtime> | Runtime;
}

/** A lazily supplied command registration unit for the harness CLI. */
export interface CommandModule {
  /** Command name as shown in help. */
  name: string;
  /** Registers the command and its options with the root program. */
  register(program: Command, ctx: CliContext): void;
}

/** Creates a runtime lazily so command help does not load store and run-loop modules. */
export async function createCommandRuntime(
  context: CliContext,
  config: HarnessConfig,
  overrides?: RuntimeOverrides,
): Promise<Runtime> {
  if (context.createRuntime !== undefined) {
    return context.createRuntime(config, overrides);
  }
  const core = await import("@harness/core");
  return core.createRuntime(config, overrides);
}
