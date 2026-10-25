// SPDX-License-Identifier: Apache-2.0
import { createRuntime, type ModelCompletion, type ToolPort } from "@rovinos/core";
import { FakeModelPort } from "@rovinos/core/testing";
import { InMemoryEventStore } from "@rovinos/store";
import { Code, Id, JsonValue, RunConfigSchema, ToolSpecSchema } from "@rovinos/schemas";
import { z } from "zod";

const toolId = Code.parse("example.lookup");
const inputSchema = z.object({ topic: z.enum(["status"]) }).strict();
const toolSpec = ToolSpecSchema.parse({
  toolId,
  description: "Look up one synthetic project status.",
  inputSchema: JsonValue.parse(z.toJSONSchema(inputSchema)),
});

const tool: ToolPort = {
  getToolSpecs: () => [toolSpec],
  describe: (requestedToolId) =>
    requestedToolId === toolId
      ? { idempotent: true, timeoutMs: 5_000, inputSchema: toolSpec.inputSchema }
      : undefined,
  prepare: (call) => Promise.resolve(call),
  execute: (call) => {
    const input = inputSchema.parse(call.args);
    return Promise.resolve({
      outcome: "ok",
      result: JsonValue.parse({ status: `${input.topic}: green` }),
    });
  },
};

const completion = (parts: ModelCompletion["parts"], finishReason: string): ModelCompletion => ({
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
});

const model = new FakeModelPort([
  completion(
    [
      {
        type: "tool_call",
        callId: Id.parse("01J00000000000000000000000"),
        toolId,
        args: { topic: "status" },
      },
    ],
    "tool_calls",
  ),
  completion([{ type: "text", text: "The synthetic project status is green." }], "stop"),
]);

const runtime = await createRuntime(
  { run: RunConfigSchema.parse({}) },
  {
    store: new InMemoryEventStore(),
    transientVault: true,
    model,
    tool,
    policy: {
      version: Code.parse("example_policy"),
      decide: () => ({
        decision: "allow",
        ruleId: Code.parse("example_allow"),
        reason: Code.parse("example_tool"),
        editable: [],
      }),
    },
  },
);

try {
  const result = await runtime.run({ goal: "Report the synthetic project status." });
  const runId = result.events[0]?.runId;
  if (runId === undefined) {
    throw new Error("example_run_missing");
  }
  const inspectedTypes: string[] = [];
  for await (const event of runtime.store.read(runId)) {
    inspectedTypes.push(event.type);
  }
  process.stdout.write(`run status: ${result.status}\n`);
  process.stdout.write(`inspected events: ${inspectedTypes.join(", ")}\n`);
} finally {
  await runtime.close();
}
