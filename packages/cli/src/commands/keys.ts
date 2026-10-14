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
import type { CommandModule } from "../command.js";

const KEY_STORAGE_INSTRUCTIONS =
  "Store this base64 key in an environment variable or a secret store; do not commit it.";

class KeysCommandError extends HarnessError {
  readonly code: "key_id_invalid" | "key_in_use" | "key_rotation_unavailable" | "key_target_not_current";

  constructor(
    code: "key_id_invalid" | "key_in_use" | "key_rotation_unavailable" | "key_target_not_current",
  ) {
    super(code);
    this.code = code;
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

async function rotate(adapter: RotationAdapter, targetKeyId: string): Promise<number> {
  let cursor: string | undefined;
  let processed = 0;
  do {
    const result = await adapter.reencryptBatch({
      targetKeyId,
      ...(cursor === undefined ? {} : { afterCursor: cursor }),
    });
    processed += result.processed;
    cursor = result.nextCursor;
  } while (cursor !== undefined);
  return processed;
}

/** Registers local key-management commands. */
export const keysCommand: CommandModule = {
  name: "keys",
  register(program, context) {
    const keys = program.command("keys").description("Manage encryption keys");
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

    keys
      .command("rotate")
      .description("Re-encrypt stored content with the configured current key")
      .requiredOption("--to <keyId>", "target key identifier; it must be the configured current key")
      .option("--vault", "rotate the vault only")
      .option("--store", "rotate the event store only")
      .action(async (options: {
        readonly to: string;
        readonly vault?: boolean;
        readonly store?: boolean;
      }) => {
        const targetKeyId = parseKeyId(options.to);
        const onlyExplicit = options.vault === true || options.store === true;
        const selection = {
          vault: onlyExplicit ? options.vault === true : true,
          store: onlyExplicit ? options.store === true : true,
        };
        const open = context.openKeyRotation;
        if (open === undefined) {
          throw new KeysCommandError("key_rotation_unavailable");
        }
        const adapters = await open(await context.loadConfig(), selection);
        try {
          if (adapters.currentKeyId !== targetKeyId) {
            throw new KeysCommandError("key_target_not_current");
          }
          if (
            (selection.vault && adapters.vault === undefined) ||
            (selection.store && adapters.store === undefined)
          ) {
            throw new KeysCommandError("key_rotation_unavailable");
          }
          const vaultProcessed =
            selection.vault && adapters.vault !== undefined
              ? await rotate(adapters.vault, targetKeyId)
              : 0;
          const storeProcessed =
            selection.store && adapters.store !== undefined
              ? await rotate(adapters.store, targetKeyId)
              : 0;
          context.keyRotationLogger?.info("keys_rotated", {
            vault: vaultProcessed,
            store: storeProcessed,
          });
          const result = { vaultProcessed, storeProcessed };
          if (program.opts().json === true) {
            context.out.json(KeyRotationResultSchema, result);
            return;
          }
          context.out.print(
            `keys_rotated vault=${vaultProcessed} store=${storeProcessed}\n`,
          );
        } finally {
          await adapters.close();
        }
      });

    keys
      .command("retire")
      .description("Check whether a key is safe to remove from configuration")
      .argument("<keyId>", "key identifier")
      .action(async (rawKeyId: string) => {
        const keyId = parseKeyId(rawKeyId);
        const open = context.openKeyRotation;
        if (open === undefined) {
          throw new KeysCommandError("key_rotation_unavailable");
        }
        const adapters = await open(await context.loadConfig(), { vault: true, store: true });
        try {
          if (adapters.currentKeyId === keyId) {
            throw new KeysCommandError("key_in_use");
          }
          const vaultCounts = await adapters.vault?.countRowsByKey();
          const storeCounts = await adapters.store?.countRowsByKey();
          if (vaultCounts === undefined || storeCounts === undefined) {
            throw new KeysCommandError("key_rotation_unavailable");
          }
          const rowsInUse =
            vaultCounts.find((row) => row.keyId === keyId)?.count ?? 0;
          const storeRowsInUse =
            storeCounts.find((row) => row.keyId === keyId)?.count ?? 0;
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
      });
  },
};
