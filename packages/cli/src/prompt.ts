// SPDX-License-Identifier: Apache-2.0
import { createInterface } from "node:readline";
import type { Interactive } from "./command.js";
import type { Output } from "./output.js";

/**
 * Creates a yes/no terminal prompt that writes its question through the CLI output.
 *
 * @param input - Readable standard input, optionally flagged as a TTY.
 * @param out - CLI output used for the question text.
 * @returns Interactive helpers whose confirmation requires an explicit yes.
 */
export function createTerminalPrompt(
  input: NodeJS.ReadableStream & { isTTY?: boolean },
  out: Output,
): Interactive {
  return {
    isTTY: input.isTTY === true,
    confirm: async (question) => {
      out.print(`${question} [y/N] `);
      const lines = createInterface({ input });
      try {
        const answer = await new Promise<string>((resolve) => {
          lines.once("close", () => {
            resolve("");
          });
          lines.question("", resolve);
        });
        return /^y(?:es)?$/iu.test(answer.trim());
      } finally {
        lines.close();
      }
    },
  };
}
