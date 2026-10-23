// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { Id } from "@harness/schemas";
import type { ModelPort, PolicyPort, ToolPort } from "@harness/core";
import { afterEach, describe, expect, it } from "vitest";
import { defineSuite } from "../load.js";
import { InProcessExecutor } from "./inprocess.js";
import type { TrialSpec } from "../trial.js";
import { runEval } from "../runner.js";

const directories: string[] = [];

async function createDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "harness-eval-inprocess-"));
  directories.push(path);
  return path;
}

function makeTrial(workDir: string): TrialSpec {
  const suite = defineSuite({
    schemaVersion: 1,
    tasks: [
      {
        id: "synthetic_task",
        input: { goal: "Complete a synthetic tool task." },
        graders: [],
        tags: [],
      },
    ],
  });
  const task = suite.tasks[0];
  if (task === undefined) {
    throw new Error("synthetic_task_missing");
  }
  const variant = { id: "baseline" };
  return {
    suite,
    task,
    variantId: variant.id,
    variant,
    trialIndex: 0,
    seed: 42,
    workDir,
  };
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("InProcessExecutor", () => {
  it("runs a fake model/tool scenario and persists an isolated run", async () => {
    let modelCalls = 0;
    let toolCalls = 0;
    const model: ModelPort = {
      complete: () => {
        modelCalls += 1;
        return Promise.resolve({
          provider: "synthetic",
          model: "synthetic",
          parts:
            modelCalls === 1
              ? [
                  {
                    type: "tool_call",
                    callId: Id.parse("00000000000000000000000011"),
                    toolId: "fake.echo",
                    args: { value: "synthetic" },
                  },
                ]
              : [{ type: "text", text: "done" }],
          providerBlobs: null,
          usage: { inputTokens: 2, outputTokens: 1 },
          finishReason: modelCalls === 1 ? "tool_calls" : "stop",
          latencyMs: 0,
          schemaValid: true,
          repairAttempts: 0,
          fallbackDepth: 0,
        });
      },
    };
    const tool: ToolPort = {
      describe: () => ({ idempotent: true, timeoutMs: 1_000 }),
      execute: () => {
        toolCalls += 1;
        return Promise.resolve({ outcome: "ok", result: { value: "synthetic" } });
      },
    };
    const policy: PolicyPort = {
      version: "test_policy",
      decide: () => ({
        decision: "allow",
        ruleId: "test_allow",
        reason: "test_allowed",
        editable: [],
      }),
    };
    const executor = new InProcessExecutor({
      model: () => model,
      tool: () => tool,
      policy: () => policy,
    });
    const result = await executor.run(makeTrial(join(await createDirectory(), "trial")));

    expect(result.status).toBe("completed");
    expect(result.runId).toBeDefined();
    expect(result.usage).toEqual({ inputTokens: 4, outputTokens: 2, costMicros: 0 });
    expect(result.exitCode).toBe(0);
    expect(modelCalls).toBe(2);
    expect(toolCalls).toBe(1);
    expect(existsSync(result.dbPath)).toBe(true);
    expect(existsSync(result.workspaceDir)).toBe(true);
  });

  it("creates separate data stores and fresh providers for repeated trials", async () => {
    let providerCreations = 0;
    let randomValue = 0;
    const generatedKeys: string[] = [];
    const executor = new InProcessExecutor({
      clock: { now: () => 1_700_000_000_000 + providerCreations },
      randomBytes: (size) => {
        randomValue += 1;
        const bytes = new Uint8Array(size).fill(randomValue);
        generatedKeys.push(Buffer.from(bytes).toString("base64"));
        return bytes;
      },
      model: () => {
        providerCreations += 1;
        return {
          complete: () =>
            Promise.resolve({
              provider: "synthetic",
              model: "synthetic",
              parts: [{ type: "text", text: "done" }],
              providerBlobs: null,
              usage: { inputTokens: 1, outputTokens: 1 },
              finishReason: "stop",
              latencyMs: 0,
              schemaValid: true,
              repairAttempts: 0,
              fallbackDepth: 0,
            }),
        };
      },
    });
    const root = await createDirectory();
    const first = await executor.run(makeTrial(join(root, "first")));
    const second = await executor.run(makeTrial(join(root, "second")));

    expect(first.dbPath).not.toBe(second.dbPath);
    expect(first.workspaceDir).not.toBe(second.workspaceDir);
    const firstVaultPath = join(dirname(first.dbPath), "vault.db");
    const secondVaultPath = join(dirname(second.dbPath), "vault.db");
    expect(firstVaultPath).not.toBe(secondVaultPath);
    expect(existsSync(firstVaultPath)).toBe(true);
    expect(existsSync(secondVaultPath)).toBe(true);
    expect(generatedKeys).toHaveLength(2);
    expect(new Set(generatedKeys).size).toBe(2);
    expect(providerCreations).toBe(2);
  });

  it("runs planned trials beneath the output directory", async () => {
    const outDir = await createDirectory();
    const executor = new InProcessExecutor({
      model: () => ({
        complete: () =>
          Promise.resolve({
            provider: "synthetic",
            model: "synthetic",
            parts: [{ type: "text", text: "done" }],
            providerBlobs: null,
            usage: { inputTokens: 1, outputTokens: 1 },
            finishReason: "stop",
            latencyMs: 0,
            schemaValid: true,
            repairAttempts: 0,
            fallbackDepth: 0,
          }),
      }),
    });
    const suite = makeTrial(join(outDir, "unused")).suite;
    const results = await runEval(suite, [{ id: "baseline" }], executor, { outDir });

    expect(results).toHaveLength(1);
    expect(results[0]?.dbPath).toContain(join(outDir, "trials"));
    expect(existsSync(results[0]?.dbPath ?? "")).toBe(true);
  });
});
