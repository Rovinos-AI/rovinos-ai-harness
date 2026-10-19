// SPDX-License-Identifier: Apache-2.0
import type { Command } from "commander";
import type { HarnessConfig } from "@harness/config";
import { Code, HarnessError, Principal } from "@harness/schemas";
import type { ConfiguredKeyRotation, Runtime, RuntimeOverrides, ToolPort } from "@harness/core";
import type { AuditingVaultResolver } from "@harness/vault";
import type { Output } from "./output.js";

/** A clock interface injected into every CLI command. */
export interface Clock {
  /** Returns the current time as epoch milliseconds. */
  now(): number;
}

/** Terminal interaction used to confirm irreversible decisions. */
export interface Interactive {
  /** True when standard input is an interactive terminal. */
  isTTY: boolean;
  /** Asks a yes/no question and resolves true only for an explicit yes. */
  confirm(question: string): Promise<boolean>;
}

/** Audited vault resolver override used by CLI tests. */
export type CliVaultResolver = Pick<AuditingVaultResolver, "resolveMany"> & {
  /** Releases resources owned by the resolver, when applicable. */
  close?(): void;
};

/** Dependencies shared by every registered CLI command. */
export interface CliContext {
  /** Loads the validated harness configuration. */
  loadConfig(): Promise<HarnessConfig>;
  /** Optional data-directory override shared by maintenance commands. */
  readonly dataDir?: string;
  /** Writes human, JSON, and safe error output. */
  out: Output;
  /** Shared secret resolver used for runtime and configured store operations. */
  secretResolver?: RuntimeOverrides["secretResolver"];
  /** Provides the current time without direct clock access in commands. */
  clock: Clock;
  /** Creates a composed run-loop runtime, optionally replacing its ports. */
  createRuntime?(config: HarnessConfig, overrides?: RuntimeOverrides): Promise<Runtime> | Runtime;
  /** Terminal prompt used to confirm approval decisions; absent means non-interactive. */
  interactive?: Interactive;
  /** Test override for the runtime vault used by `harness approvals show --reveal`. */
  createVaultResolver?(
    config: HarnessConfig,
  ): Promise<CliVaultResolver | undefined> | CliVaultResolver | undefined;
  /** Supplies the PII-aware tool port used to validate approval edits. */
  createToolPort?(config: HarnessConfig): Promise<ToolPort | undefined> | ToolPort | undefined;
  /** Opens configured maintenance adapters for key rotation and retirement. */
  openKeyRotation?(
    config: HarnessConfig,
    selection: { readonly vault: boolean; readonly store: boolean },
  ): Promise<ConfiguredKeyRotation>;
  /** Emits the registered metadata-only key-rotation completion record. */
  keyRotationLogger?: (counts: { readonly vault: number; readonly store: number }) => void;
}

/** A lazily supplied command registration unit for the harness CLI. */
export interface CommandModule {
  /** Command name as shown in help. */
  name: string;
  /** Registers the command and its options with the root program. */
  register(program: Command, ctx: CliContext): void;
}

class CliPrincipalError extends HarnessError {
  readonly code = "usage";

  constructor() {
    super("CLI principal name is invalid.");
    this.name = "CliPrincipalError";
  }
}

/** Resolves an attributable, unauthenticated CLI principal from `--as` or config. */
export function cliPrincipal(config: HarnessConfig, as?: string): Principal {
  if (as === undefined) {
    return Principal.parse(config.cli?.principal ?? "cli.local");
  }
  const name = Code.safeParse(as);
  if (!name.success) {
    throw new CliPrincipalError();
  }
  return Principal.parse(`cli.${name.data}`);
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
