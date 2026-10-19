// SPDX-License-Identifier: Apache-2.0
import { randomBytes } from "node:crypto";
import {
  Code,
  HarnessError,
  KEY_PROVIDER_KEY_BYTES,
  KeyGenerateResultSchema,
  KeyRetireResultSchema,
  KeyRotationResultSchema,
} from "@harness/schemas";
import type { CliContext, CommandModule } from "../command.js";
import type { Command } from "commander";

const KEY_STORAGE_INSTRUCTIONS =
  "Store this base64 key in an environment variable or a secret store; do not commit it.";

class KeysCommandError extends HarnessError {
  readonly code:
    | "key_id_invalid"
    | "key_in_use"
    | "key_rotation_unavailable"
    | "key_rotation_incomplete"
    | "key_target_not_current";
  readonly hint: string | undefined;

  constructor(
    code:
      | "key_id_invalid"
      | "key_in_use"
      | "key_rotation_unavailable"
      | "key_rotation_incomplete"
      | "key_target_not_current",
    hint?: string,
  ) {
    super(code);
    this.code = code;
    this.hint = hint;
  }
}

interface RotationAdapter {
  reencryptBatch(input: {
    readonly targetKeyId: string;
    readonly afterCursor?: string;
  }): Promise<{ readonly processed: number; readonly nextCursor?: string | undefined }>;
  countRowsByKey(): Promise<readonly { readonly keyId: string; readonly count: number }[]>;
}

function parseKeyId(keyId: string): string {
  const result = Code.safeParse(keyId);
  if (!result.success) {
    throw new KeysCommandError("key_id_invalid");
  }
  return result.data;
}

interface RotationResult {
  readonly processed: number;
  readonly remaining: number;
}

async function rotate(adapter: RotationAdapter, targetKeyId: string): Promise<RotationResult> {
  let processed = 0;
  let remaining = 0;
  for (let pass = 0; pass < 3; pass += 1) {
    let cursor: string | undefined;
    do {
      const result = await adapter.reencryptBatch({
        targetKeyId,
        ...(cursor === undefined ? {} : { afterCursor: cursor }),
      });
      processed += result.processed;
      cursor = result.nextCursor;
    } while (cursor !== undefined);
    const counts = await adapter.countRowsByKey();
    remaining = counts.reduce(
      (total, row) => total + (row.keyId === targetKeyId ? 0 : row.count),
      0,
    );
    if (remaining === 0) {
      return { processed, remaining };
    }
  }
  return { processed, remaining };
}

async function rotateSelected(
  adapter: RotationAdapter | undefined,
  selected: boolean,
  targetKeyId: string,
): Promise<RotationResult> {
  if (!selected) {
    return { processed: 0, remaining: 0 };
  }
  if (adapter === undefined) {
    throw new KeysCommandError("key_rotation_unavailable");
  }
  return rotate(adapter, targetKeyId);
}

interface RotateOptions {
  readonly to: string;
  readonly vault?: boolean;
  readonly store?: boolean;
}

function registerGenerate(keys: Command, context: CliContext, program: Command): void {
  keys
    .command("generate")
    .description("Generate a 32-byte key for an environment variable or secret store")
    .action(() => {
      const result = {
        key: randomBytes(KEY_PROVIDER_KEY_BYTES).toString("base64"),
        instructions: KEY_STORAGE_INSTRUCTIONS,
      };
      if (program.opts().json === true) {
        context.out.json(KeyGenerateResultSchema, result);
        return;
      }
      context.out.print(`${result.key}\n${result.instructions}\n`);
    });
}

async function runRotation(
  options: RotateOptions,
  program: Command,
  context: CliContext,
): Promise<void> {
  const targetKeyId = parseKeyId(options.to);
  const onlyExplicit = options.vault === true || options.store === true;
  const selection = {
    vault: onlyExplicit ? options.vault === true : true,
    store: onlyExplicit ? options.store === true : true,
  };
  if (context.openKeyRotation === undefined) {
    throw new KeysCommandError("key_rotation_unavailable");
  }
  const adapters = await context.openKeyRotation(await context.loadConfig(), selection);
  try {
    if (adapters.currentKeyId !== targetKeyId) {
      throw new KeysCommandError("key_target_not_current");
    }
    const vaultResult = await rotateSelected(adapters.vault, selection.vault, targetKeyId);
    const storeResult = await rotateSelected(adapters.store, selection.store, targetKeyId);
    if (vaultResult.remaining > 0 || storeResult.remaining > 0) {
      throw new KeysCommandError(
        "key_rotation_incomplete",
        `remaining_vault_${String(vaultResult.remaining)}_store_${String(storeResult.remaining)}`,
      );
    }
    const counts = { vault: vaultResult.processed, store: storeResult.processed };
    const logger = context.keyRotationLogger;
    logger?.(counts);
    const result = {
      vaultProcessed: counts.vault,
      storeProcessed: counts.store,
    };
    if (program.opts().json === true) {
      context.out.json(KeyRotationResultSchema, result);
      return;
    }
    context.out.print(`keys_rotated vault=${String(counts.vault)} store=${String(counts.store)}\n`);
  } finally {
    await adapters.close();
  }
}

function registerRotate(keys: Command, program: Command, context: CliContext): void {
  keys
    .command("rotate")
    .description("Re-encrypt stored content with the configured current key")
    .requiredOption("--to <keyId>", "target key identifier; it must be the configured current key")
    .option("--vault", "rotate the vault only")
    .option("--store", "rotate the event store only")
    .action((options: RotateOptions) => runRotation(options, program, context));
}

async function runRetirement(
  rawKeyId: string,
  program: Command,
  context: CliContext,
): Promise<void> {
  const keyId = parseKeyId(rawKeyId);
  if (context.openKeyRotation === undefined) {
    throw new KeysCommandError("key_rotation_unavailable");
  }
  const adapters = await context.openKeyRotation(await context.loadConfig(), {
    vault: true,
    store: true,
  });
  try {
    if (adapters.currentKeyId === keyId) {
      throw new KeysCommandError("key_in_use");
    }
    const vaultCounts = await adapters.vault?.countRowsByKey();
    const storeCounts = await adapters.store?.countRowsByKey();
    if (vaultCounts === undefined || storeCounts === undefined) {
      throw new KeysCommandError("key_rotation_unavailable");
    }
    const rowsInUse = vaultCounts.find((row) => row.keyId === keyId)?.count ?? 0;
    const storeRowsInUse = storeCounts.find((row) => row.keyId === keyId)?.count ?? 0;
    if (rowsInUse + storeRowsInUse > 0) {
      throw new KeysCommandError("key_in_use");
    }
    const result = { keyId, status: "safe_to_remove" as const };
    if (program.opts().json === true) {
      context.out.json(KeyRetireResultSchema, result);
      return;
    }
    context.out.print(`key_safe_to_remove ${keyId}\n`);
  } finally {
    await adapters.close();
  }
}

function registerRetire(keys: Command, program: Command, context: CliContext): void {
  keys
    .command("retire")
    .description("Check whether a key is safe to remove from configuration")
    .argument("<keyId>", "key identifier")
    .action((rawKeyId: string) => runRetirement(rawKeyId, program, context));
}

/** Registers local key-management commands. */
export const keysCommand: CommandModule = {
  name: "keys",
  /** Registers the `keys` command. */
  register(program, context) {
    const keys = program.command("keys").description("Manage encryption keys");
    registerGenerate(keys, context, program);
    registerRotate(keys, program, context);
    registerRetire(keys, program, context);
  },
};
