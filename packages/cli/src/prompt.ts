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
      const answer = await readLine(input, undefined);
      return /^y(?:es)?$/iu.test(answer.trim());
    },
    prompt: async (question, signal) => {
      out.print(question);
      return readLine(input, signal);
    },
  };
}

function readLine(input: NodeJS.ReadableStream, signal: AbortSignal | undefined): Promise<string> {
  const lines = createInterface({ input });
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      signal?.removeEventListener("abort", onAbort);
      lines.close();
    };
    const onAbort = (): void => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(signal?.reason instanceof Error ? signal.reason : new Error("prompt_aborted"));
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    lines.once("close", () => {
      if (!settled) {
        settled = true;
        cleanup();
        resolve("");
      }
    });
    lines.question("", (answer) => {
      if (!settled) {
        settled = true;
        cleanup();
        resolve(answer);
      }
    });
  });
}
