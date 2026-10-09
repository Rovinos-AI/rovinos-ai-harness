// SPDX-License-Identifier: Apache-2.0
import { readFile } from "node:fs/promises";
import {
  FakeModelScriptSchema,
  HarnessError,
  JsonValue,
  RunInputSchema,
  RunResultSchema,
  parseJson,
  type FakeModelCompletion,
} from "@harness/schemas";
import type { ModelCompletion, ModelPort, ModelRequest, RunContext } from "@harness/core";
import type { CommandModule } from "../command.js";
import { createCommandRuntime } from "../command.js";

class ScriptedModelError extends HarnessError {
  override readonly code = "fake_model_script_exhausted";

  constructor() {
    super("The fake model script is exhausted.");
  }
}

class ScriptedModel implements ModelPort {
  private next = 0;

  constructor(private readonly script: readonly FakeModelCompletion[]) {}

  complete(_request: ModelRequest, _context: RunContext): Promise<ModelCompletion> {
    const completion = this.script[this.next];
    this.next += 1;
    return completion === undefined
      ? Promise.reject(new ScriptedModelError())
      : Promise.resolve({
          ...completion,
          usage: {
            inputTokens: completion.usage.inputTokens,
            outputTokens: completion.usage.outputTokens,
            ...(completion.usage.costMicros === undefined
              ? {}
              : { costMicros: completion.usage.costMicros }),
          },
        });
  }
}

async function readInput(path: string): Promise<ReturnType<typeof RunInputSchema.parse>> {
  let content: string;
  if (path === "-") {
    content = "";
    for await (const chunk of process.stdin) {
      content += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    }
  } else {
    content = await readFile(path, { encoding: "utf8" });
  }
  return parseJson(RunInputSchema, content);
}

async function readFakeModel(path: string): Promise<ScriptedModel> {
  const content = await readFile(path, { encoding: "utf8" });
  return new ScriptedModel(parseJson(FakeModelScriptSchema, content));
}

class RunStatusError extends HarnessError {
  override readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

function throwForRunStatus(
  status: "completed" | "failed" | "running" | "suspended" | "pending" | "cancelled",
  events: readonly { readonly type: string }[],
): void {
  if (status === "suspended") {
    throw new RunStatusError("suspended");
  }
  if (status === "failed") {
    throw new RunStatusError(
      events.some((event) => event.type === "budget_exceeded") ? "budget_exceeded" : "run_failed",
    );
  }
  if (status !== "completed") {
    throw new RunStatusError("run_failed");
  }
}

/** Registers the `harness run` command. */
export const runCommand: CommandModule = {
  name: "run",
  register(program, context) {
    program
      .command("run")
      .description("Start a run from a JSON input file or standard input")
      .requiredOption("--input <json-file|->", "JSON input file, or - to read standard input")
      .option("--fake-model <script.json>", "JSON array of scripted model completions")
      .action(async (options: { readonly input: string; readonly fakeModel?: string }) => {
        const input = await readInput(options.input);
        const config = await context.loadConfig();
        const model =
          options.fakeModel === undefined ? undefined : await readFakeModel(options.fakeModel);
        const runtime = await createCommandRuntime(
          context,
          config,
          model === undefined ? undefined : { model },
        );
        try {
          const goal: JsonValue =
            input.metadata === undefined
              ? { goal: input.goal }
              : { goal: input.goal, metadata: input.metadata };
          const result = await runtime.run(goal);
          const firstEvent = result.events[0];
          if (firstEvent === undefined) {
            throw new RunStatusError("run_failed");
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
