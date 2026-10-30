// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { Id } from "@rovinos/schemas";
import type { JsonValue } from "@rovinos/schemas";
import type { ModelPort, PolicyPort, ToolPort } from "@rovinos/core";
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

function makeTrial(workDir: string, includeMetadata = false, human?: unknown): TrialSpec {
  const suite = defineSuite({
    schemaVersion: 1,
    tasks: [
      {
        id: "synthetic_task",
        input: {
          goal: "Complete a synthetic tool task.",
          ...(includeMetadata ? { metadata: { category: "synthetic" } } : {}),
        },
        ...(human === undefined ? {} : { human }),
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
    const result = await executor.run(makeTrial(join(await createDirectory(), "trial"), true));

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

  function approvalPorts(
    args: { readonly value: string },
    callCount = 1,
    allowAfterEdit = false,
  ): {
    readonly model: ModelPort;
    readonly tool: ToolPort;
    readonly toolCalls: JsonValue[];
    readonly policy: PolicyPort;
  } {
    let modelCalls = 0;
    let policyCalls = 0;
    const toolCalls: JsonValue[] = [];
    return {
      model: {
        complete: () => {
          const call = modelCalls < callCount;
          const callId = Id.parse(
            `000000000000000000000000${String(modelCalls + 1).padStart(2, "0")}`,
          );
          modelCalls += 1;
          return Promise.resolve({
            provider: "synthetic",
            model: "synthetic",
            parts: call
              ? [{ type: "tool_call" as const, callId, toolId: "fake.echo", args }]
              : [{ type: "text" as const, text: "done" }],
            providerBlobs: null,
            usage: { inputTokens: 1, outputTokens: 1 },
            finishReason: call ? "tool_calls" : "stop",
            latencyMs: 0,
            schemaValid: true,
            repairAttempts: 0,
            fallbackDepth: 0,
          });
        },
      },
      tool: {
        prepare: (call) => Promise.resolve(call),
        describe: () => ({
          idempotent: true,
          timeoutMs: 1_000,
          inputSchema: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
            additionalProperties: false,
          },
        }),
        execute: (call) => {
          toolCalls.push(call.args);
          return Promise.resolve({ outcome: "ok", result: { value: "synthetic" } });
        },
      },
      toolCalls,
      policy: {
        version: "synthetic",
        decide: () => {
          policyCalls += 1;
          return {
            decision: allowAfterEdit && policyCalls > 1 ? "allow" : "ask",
            ruleId: "eval_approval",
            reason: "synthetic_approval",
            editable: ["/value"],
          };
        },
      },
    };
  }

  it("uses the first matching approval rule and records approved counts", async () => {
    const workDir = join(await createDirectory(), "trial");
    const ports = approvalPorts({ value: "synthetic" });
    const executor = new InProcessExecutor({
      model: () => ports.model,
      tool: () => ports.tool,
      policy: () => ports.policy,
    });

    const result = await executor.run(
      makeTrial(workDir, false, {
        rules: [
          { match: { toolId: "fake.echo", ruleId: "eval_approval" }, decision: "approve" },
          {
            match: { pointerEquals: { pointer: "/value", value: "synthetic" } },
            decision: "deny",
          },
        ],
        default: "deny",
      }),
    );

    expect(result).toMatchObject({
      status: "completed",
      approvals: { approved: 1, denied: 0, edited: 0 },
      unsafeAutoApprove: false,
    });
    expect(ports.toolCalls).toEqual([{ value: "synthetic" }]);
  });

  it("matches tokenized argument values by token type only", async () => {
    const workDir = join(await createDirectory(), "trial");
    const ports = approvalPorts({ value: "<EMAIL_1>" });
    const executor = new InProcessExecutor({
      model: () => ports.model,
      tool: () => ports.tool,
      policy: () => ports.policy,
    });

    const result = await executor.run(
      makeTrial(workDir, false, {
        rules: [
          { match: { pointerEquals: { pointer: "/value", value: "email" } }, decision: "approve" },
        ],
        default: "deny",
      }),
    );

    expect(result.approvals.approved).toBe(1);
    expect(ports.toolCalls).toEqual([{ value: "<EMAIL_1>" }]);
  });

  it("records denied approvals without executing the tool", async () => {
    const workDir = join(await createDirectory(), "trial");
    const ports = approvalPorts({ value: "synthetic" });
    const executor = new InProcessExecutor({
      model: () => ports.model,
      tool: () => ports.tool,
      policy: () => ports.policy,
    });

    const result = await executor.run(makeTrial(workDir, false, { rules: [], default: "deny" }));

    expect(result).toMatchObject({
      status: "completed",
      approvals: { approved: 0, denied: 1, edited: 0 },
    });
    expect(ports.toolCalls).toEqual([]);
  });

  it("validates and applies edited approvals through the runtime", async () => {
    const workDir = join(await createDirectory(), "trial");
    const ports = approvalPorts({ value: "synthetic" }, 1, true);
    const executor = new InProcessExecutor({
      model: () => ports.model,
      tool: () => ports.tool,
      policy: () => ports.policy,
    });

    const result = await executor.run(
      makeTrial(workDir, false, {
        rules: [
          {
            match: { toolId: "fake.echo" },
            decision: "edit",
            edits: [{ pointer: "/value", value: "edited" }],
          },
        ],
        default: "deny",
      }),
    );

    expect(result.approvals.edited).toBe(1);
    expect(ports.toolCalls).toEqual([{ value: "edited" }]);
  });

  it("surfaces the approval edit validation code", async () => {
    const workDir = join(await createDirectory(), "trial");
    const ports = approvalPorts({ value: "synthetic" });
    const executor = new InProcessExecutor({
      model: () => ports.model,
      tool: () => ports.tool,
      policy: () => ports.policy,
    });

    await expect(
      executor.run(
        makeTrial(workDir, false, {
          rules: [
            {
              match: {},
              decision: "edit",
              edits: [{ pointer: "/not_editable", value: "rejected" }],
            },
          ],
          default: "deny",
        }),
      ),
    ).rejects.toMatchObject({ code: "edit_not_allowed" });
  });

  it("reports unsafe auto-approval and fails when the resume limit is exhausted", async () => {
    const firstWorkDir = join(await createDirectory(), "approved");
    const approvingPorts = approvalPorts({ value: "synthetic" });
    const approvingExecutor = new InProcessExecutor({
      model: () => approvingPorts.model,
      tool: () => approvingPorts.tool,
      policy: () => approvingPorts.policy,
    });
    const autoApproved = await approvingExecutor.run(
      makeTrial(firstWorkDir, false, {
        rules: [],
        default: "approve",
        unsafeAutoApprove: true,
      }),
    );

    expect(autoApproved.unsafeAutoApprove).toBe(true);
    expect(autoApproved.approvals.approved).toBe(1);

    const secondWorkDir = join(await createDirectory(), "exhausted");
    const repeatedPorts = approvalPorts({ value: "synthetic" }, 2);
    const repeatedExecutor = new InProcessExecutor({
      model: () => repeatedPorts.model,
      tool: () => repeatedPorts.tool,
      policy: () => repeatedPorts.policy,
    });
    const exhausted = await repeatedExecutor.run(
      makeTrial(secondWorkDir, false, {
        rules: [],
        default: "deny",
        maxResumes: 1,
      }),
    );

    expect(exhausted).toMatchObject({
      status: "error",
      errorCode: "human_max_resumes_exceeded",
      approvals: { denied: 1 },
    });
  });
});
