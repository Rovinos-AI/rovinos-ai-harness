// SPDX-License-Identifier: Apache-2.0
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createRuntime,
  type ModelCompletion,
  type ModelToolCall,
  type ToolPort,
} from "@rovinos/core";
import { FakeModelPort } from "@rovinos/core/testing";
import { Code, Id, JsonValue, parseJson, RunConfigSchema, ToolSpecSchema } from "@rovinos/schemas";
import { z } from "zod";

const toolId = Code.parse("example.increment");
const inputSchema = z.object({ label: z.literal("synthetic") }).strict();
const toolSpec = ToolSpecSchema.parse({
  toolId,
  description: "Increment a synthetic counter exactly once.",
  inputSchema: JsonValue.parse(z.toJSONSchema(inputSchema)),
});
const receiptSchema = z.object({ callId: Id, count: z.number().int().positive() }).strict();
const callId = Id.parse("01J00000000000000000000001");

function completion(parts: ModelCompletion["parts"], finishReason: string): ModelCompletion {
  return {
    parts,
    usage: { inputTokens: 3, outputTokens: 5, costMicros: 0 },
    finishReason,
    provider: Code.parse("scripted"),
    model: Code.parse("example"),
    latencyMs: 0,
    schemaValid: true,
    repairAttempts: 0,
    fallbackDepth: 0,
    providerBlobs: null,
  };
}

function modelFor(mode: "start" | "resume"): FakeModelPort {
  const finalResponse = completion(
    [{ type: "text", text: "The interrupted action was recovered." }],
    "stop",
  );
  if (mode === "resume") {
    return new FakeModelPort([finalResponse]);
  }
  return new FakeModelPort([
    completion(
      [
        {
          type: "tool_call",
          callId,
          toolId,
          args: { label: "synthetic" },
        },
      ],
      "tool_calls",
    ),
  ]);
}

async function readReceipt(directory: string): Promise<z.infer<typeof receiptSchema> | undefined> {
  try {
    return parseJson(
      receiptSchema,
      await readFile(join(directory, "counter-receipt.json"), "utf8"),
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function createTool(directory: string): ToolPort {
  return {
    getToolSpecs: () => [toolSpec],
    describe: (requestedToolId) =>
      requestedToolId === toolId
        ? { idempotent: false, timeoutMs: 30_000, inputSchema: toolSpec.inputSchema }
        : undefined,
    prepare: (call) => Promise.resolve(call),
    execute: async (call: ModelToolCall, context) => {
      inputSchema.parse(call.args);
      const previous = await readReceipt(directory);
      const receipt = receiptSchema.parse({
        callId: call.callId,
        count: (previous?.count ?? 0) + 1,
      });
      const receiptPath = join(directory, "counter-receipt.json");
      await writeFile(`${receiptPath}.${String(process.pid)}.tmp`, JSON.stringify(receipt), {
        flag: "wx",
      });
      await rename(`${receiptPath}.${String(process.pid)}.tmp`, receiptPath);
      await writeFile(join(directory, "effect-ready"), "ready\n", { flag: "wx" });
      await new Promise<void>((resolve) => {
        if (context.signal.aborted) {
          resolve();
        } else {
          context.signal.addEventListener(
            "abort",
            (_event: Event): void => {
              resolve();
            },
            { once: true },
          );
        }
      });
      if (context.signal.aborted) {
        return {
          outcome: "error",
          errorCode: Code.parse("tool_cancelled"),
          result: null,
        };
      }
      return { outcome: "ok", result: JsonValue.parse({ count: receipt.count }) };
    },
    resumeStrategy: (requestedToolId) =>
      requestedToolId === toolId
        ? {
            onDanglingIntent: async (call) => {
              const receipt = await readReceipt(directory);
              if (receipt === undefined) {
                return { kind: "rerun" };
              }
              if (receipt.callId !== call.callId) {
                return { kind: "shutdown" };
              }
              return {
                kind: "result",
                execution: {
                  outcome: "ok",
                  result: JsonValue.parse({ count: receipt.count }),
                },
              };
            },
          }
        : undefined,
  };
}

async function startInterruptedRun(directory: string): Promise<never> {
  const runtime = await createRuntime(
    { run: RunConfigSchema.parse({}) },
    {
      dataDir: directory,
      transientVault: true,
      model: modelFor("start"),
      tool: createTool(directory),
      policy: {
        version: Code.parse("example_policy"),
        decide: () => ({
          decision: "allow",
          ruleId: Code.parse("example_allow"),
          reason: Code.parse("example_action"),
          editable: [],
        }),
      },
    },
  );
  const run = runtime.start({ goal: "Increment the synthetic counter." });
  await run.started;
  await writeFile(join(directory, "run-id"), `${run.runId}\n`, { flag: "wx" });
  try {
    await run.completion;
  } finally {
    await runtime.close();
  }
  throw new Error("example_run_did_not_pause");
}

async function resumeInterruptedRun(directory: string, runId: string): Promise<void> {
  const runtime = await createRuntime(
    { run: RunConfigSchema.parse({}) },
    {
      dataDir: directory,
      transientVault: true,
      model: modelFor("resume"),
      tool: createTool(directory),
      policy: {
        version: Code.parse("example_policy"),
        decide: () => ({
          decision: "allow",
          ruleId: Code.parse("example_allow"),
          reason: Code.parse("example_action"),
          editable: [],
        }),
      },
    },
  );
  try {
    const result = await runtime.resume(Id.parse(runId));
    const receipt = await readReceipt(directory);
    if (result.status !== "completed" || receipt?.count !== 1) {
      throw new Error("example_resume_result_invalid");
    }
    process.stdout.write(`run status: ${result.status}\n`);
    process.stdout.write(`non-idempotent tool executions: ${String(receipt.count)}\n`);
  } finally {
    await runtime.close();
  }
}

async function main(): Promise<void> {
  const [mode, directory, runId] = process.argv.slice(2);
  if (mode === "start" && directory !== undefined) {
    await mkdir(directory, { recursive: true });
    await startInterruptedRun(directory);
    return;
  }
  if (mode === "resume" && directory !== undefined && runId !== undefined) {
    await resumeInterruptedRun(directory, runId);
    return;
  }
  process.stderr.write("usage: run.ts start|resume <data-dir> [run-id]\n");
  process.exitCode = 2;
}

await main().catch((error: unknown) => {
  const code =
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[a-z0-9_.-]{1,64}$/u.test(error.code)
      ? error.code
      : "crash_example_failed";
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
});
