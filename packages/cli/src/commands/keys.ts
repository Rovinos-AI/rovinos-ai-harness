// SPDX-License-Identifier: Apache-2.0
import { randomBytes } from "node:crypto";
import { KEY_PROVIDER_KEY_BYTES, KeyGenerateResultSchema } from "@harness/schemas";
import type { CommandModule } from "../command.js";

const KEY_STORAGE_INSTRUCTIONS =
  "Store this base64 key in an environment variable or a secret store; do not commit it.";

/** Registers local key-management commands. */
export const keysCommand: CommandModule = {
  name: "keys",
  register(program, context) {
    program
      .command("keys")
      .description("Manage encryption keys")
      .command("generate")
      .description("Generate a 32-byte key for an environment variable or secret store")
      .action((_options, command) => {
        const result = {
          key: randomBytes(KEY_PROVIDER_KEY_BYTES).toString("base64"),
          instructions: KEY_STORAGE_INSTRUCTIONS,
        };
        const parentOptions = command.optsWithGlobals<{ json?: boolean }>();
        if (parentOptions.json === true) {
          context.out.json(KeyGenerateResultSchema, result);
          return;
        }
        context.out.print(`${result.key}\n${result.instructions}\n`);
      });
  },
};
