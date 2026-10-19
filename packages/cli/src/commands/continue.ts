// SPDX-License-Identifier: Apache-2.0
import { readFile } from "node:fs/promises";
import {
  HarnessError,
  Id,
  RunInputSchema,
  RunResultSchema,
  parseJson,
  type RunInput,
} from "@harness/schemas";
import type { CommandModule } from "../command.js";
import { createCommandRuntime } from "../command.js";

class InvalidInputStreamError extends HarnessError {
  override readonly code = "input_invalid";

  constructor() {
    super("Input stream contains an unsupported chunk.");
  }
}

class ContinueStatusError extends HarnessError {
  override readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

async function readInput(path: string): Promise<RunInput> {
  let content: string;
  if (path === "-") {
    content = "";
    for await (const inputChunk of process.stdin) {
      const chunk: unknown = inputChunk;
      if (typeof chunk === "string") {
        content += chunk;
      } else if (Buffer.isBuffer(chunk)) {
        content += chunk.toString("utf8");
      } else {
        throw new InvalidInputStreamError();
      }
    }
  } else {
    content = await readFile(path, { encoding: "utf8" });
  }
  return parseJson(RunInputSchema, content);
}

function throwForRunStatus(
  status: "completed" | "failed" | "running" | "suspended" | "pending" | "cancelled",
  events: readonly { readonly type: string }[],
): void {
  if (status === "suspended") {
    throw new ContinueStatusError("suspended");
  }
  if (status === "failed") {
    throw new ContinueStatusError(
      events.some((event) => event.type === "budget_exceeded") ? "budget_exceeded" : "run_failed",
    );
  }
  if (status !== "completed") {
    throw new ContinueStatusError("run_failed");
  }
}

/** Registers the `harness continue` command. */
export const continueCommand: CommandModule = {
  name: "continue",
  /** Registers the `continue` command. */
  register(program, context) {
    program
      .command("continue")
      .description("Continue a finished run with a follow-up input")
      .argument("<runId>", "terminal run identifier")
      .requiredOption("--input <json-file|->", "JSON input file, or - to read standard input")
      .action(async (value: string, options: { readonly input: string }) => {
        const runId = Id.parse(value);
        const input = await readInput(options.input);
        const config = await context.loadConfig();
        const runtime = await createCommandRuntime(context, config);
        try {
          const result = await runtime.continueRun(runId, input);
          const firstEvent = result.events[0];
          if (firstEvent === undefined) {
            throw new ContinueStatusError("run_failed");
          }
          const output = { runId: firstEvent.runId, status: result.status };
          context.out.json(RunResultSchema, output);
          context.out.print(`${output.runId}\n`);
          throwForRunStatus(result.status, result.events);
        } finally {
          await runtime.close();
        }
      });
  },
};
