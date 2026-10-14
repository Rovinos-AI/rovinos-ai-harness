// SPDX-License-Identifier: Apache-2.0
import { HarnessError, StoreMigrateResultSchema, StorePurgeResultSchema } from "@harness/schemas";
import type { HarnessConfig } from "@harness/config";
import type { EventStore } from "@harness/store";
import { purgeExpired, type VaultAdmin } from "@harness/vault";
import type { CliContext, CommandModule } from "../command.js";

interface StoreCommandOperations {
  migrate(
    config: HarnessConfig,
    dryRun: boolean,
    appliedAt: number,
    secretResolver: CliContext["secretResolver"],
  ): Promise<string[]>;
  openStore(
    config: HarnessConfig,
    dryRun: boolean,
    secretResolver: CliContext["secretResolver"],
  ): Promise<EventStore>;
  openVaultAdmin?(
    config: HarnessConfig,
    clock: CliContext["clock"],
    secretResolver: CliContext["secretResolver"],
  ): Promise<VaultAdmin & { close(): void }>;
}

class StoreCommandError extends HarnessError {
  override readonly code: "retention_not_configured" | "retention_hook_failed";

  constructor(code: "retention_not_configured" | "retention_hook_failed") {
    super(code);
    this.code = code;
  }
}

interface StoreCommandInput {
  context: CliContext;
  config: HarnessConfig;
  dryRun: boolean;
  jsonMode: boolean;
  operations: StoreCommandOperations;
}

const defaultOperations: StoreCommandOperations = {
  async migrate(config, dryRun, appliedAt, secretResolver) {
    const core = await import("@harness/core");
    return core.migrateConfiguredStore(config, {
      dryRun,
      appliedAt,
      ...(secretResolver === undefined ? {} : { secretResolver }),
    });
  },
  async openStore(config, dryRun, secretResolver) {
    const core = await import("@harness/core");
    return core.openConfiguredStore(config, {
      readOnly: dryRun,
      ...(secretResolver === undefined ? {} : { secretResolver }),
    });
  },
  async openVaultAdmin(config, clock, secretResolver) {
    const core = await import("@harness/core");
    return core.openConfiguredVaultAdmin(config, {
      clock,
      ...(secretResolver === undefined ? {} : { secretResolver }),
    });
  },
};

async function writeMigrateResult({
  context,
  config,
  dryRun,
  jsonMode,
  operations,
}: StoreCommandInput): Promise<void> {
  const versions = await operations.migrate(
    config,
    dryRun,
    context.clock.now(),
    context.secretResolver,
  );
  const result = {
    applied: dryRun ? [] : versions,
    pending: dryRun ? versions : [],
  };
  context.out.json(StoreMigrateResultSchema, result);
  if (!jsonMode) {
    if (dryRun) {
      context.out.print(
        versions.length === 0
          ? "No pending migrations.\n"
          : `Pending migrations: ${versions.join(", ")}\n`,
      );
    } else {
      context.out.print(
        versions.length === 0
          ? "No migrations applied.\n"
          : `Applied migrations: ${versions.join(", ")}\n`,
      );
    }
  }
}

async function writePurgeResult({
  context,
  config,
  dryRun,
  jsonMode,
  operations,
}: StoreCommandInput): Promise<void> {
  const policy = config.store.retention;
  if (policy === undefined) {
    throw new StoreCommandError("retention_not_configured");
  }
  const store = await operations.openStore(config, dryRun, context.secretResolver);
  let vault: (VaultAdmin & { close(): void }) | undefined;
  try {
    const vaultAdmin =
      dryRun || operations.openVaultAdmin === undefined
        ? undefined
        : await operations.openVaultAdmin(config, context.clock, context.secretResolver);
    vault = vaultAdmin;
    const { purgeExpiredRuns } = await import("@harness/store");
    const result = await purgeExpiredRuns({
      store,
      clock: context.clock,
      policy,
      dryRun,
      ...(vaultAdmin === undefined
        ? {}
        : {
            onRunPurged: async (runId) => {
              await vaultAdmin.purge(runId);
            },
          }),
    });
    if (vaultAdmin !== undefined) {
      await purgeExpired({
        vault: vaultAdmin,
        clock: context.clock,
        purgeAfterDays: config.vault.purgeAfterDays,
      });
    }
    context.out.json(StorePurgeResultSchema, result);
    if (!jsonMode) {
      context.out.table([
        ["examined", "purged", "skippedActive", "hookFailures"],
        [result.examined, result.purged, result.skippedActive, result.hookFailures],
      ]);
    }
    if (result.hookFailures > 0) {
      throw new StoreCommandError("retention_hook_failed");
    }
  } finally {
    try {
      await store.close();
    } finally {
      vault?.close();
    }
  }
}

/**
 * Creates the `harness store` command group.
 *
 * @param operations - Optional store operations for deterministic command tests.
 * @returns A command module that applies migrations and purges expired runs.
 */
export function createStoreCommand(
  operations: StoreCommandOperations = defaultOperations,
): CommandModule {
  return {
    name: "store",
    register(program, context) {
      const store = program.command("store").description("Manage the event store");
      store
        .command("migrate")
        .description("Apply or list pending store schema migrations")
        .option("--dry-run", "list pending migrations without applying them")
        .action(async (options: { readonly dryRun?: boolean }) => {
          const config = await context.loadConfig();
          await writeMigrateResult({
            context,
            config,
            dryRun: options.dryRun === true,
            jsonMode: program.opts<{ json?: boolean }>().json === true,
            operations,
          });
        });
      store
        .command("purge")
        .description("Purge expired terminal runs using the configured retention windows")
        .option("--dry-run", "count eligible runs without deleting them")
        .action(async (options: { readonly dryRun?: boolean }) => {
          const config = await context.loadConfig();
          await writePurgeResult({
            context,
            config,
            dryRun: options.dryRun === true,
            jsonMode: program.opts<{ json?: boolean }>().json === true,
            operations,
          });
        });
    },
  };
}

/** The default `harness store` command module. */
export const storeCommand = createStoreCommand();
