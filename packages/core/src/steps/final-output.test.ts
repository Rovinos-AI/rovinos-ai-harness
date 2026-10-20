// SPDX-License-Identifier: Apache-2.0
import { ensureTracingFallback } from "@harness/telemetry";
import {
  FakeClock,
  Id,
  QuotasConfigSchema,
  RunConfigSchema,
  SequentialIdGenerator,
} from "@harness/schemas";
import { InMemoryEventStore } from "@harness/store";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import { NaiveContext } from "../context/naive-context.js";
import { RunRecorder } from "../recorder.js";
import type { ModelCompletion, ModelPort, ToolPort } from "../ports.js";
import { RUN_SPAN } from "../spans.js";
import { FakeToolPort } from "../testing/fake-tool.js";
import { runLoop } from "../loop.js";
import { QuotaService } from "../quotas.js";

const runId = Id.parse("00000000000000000000000000");
const segmentId = Id.parse("11111111111111111111111111");
const finalOutputSchema = z.object({ answer: z.string() }).strict();
const configHash = "a".repeat(64);

function completion(
  text: string,
  rungUsed?: ModelCompletion["rungUsed"],
  costMicros?: number,
): ModelCompletion {
  return {
    parts: [{ type: "text", text }],
    usage: { inputTokens: 1, outputTokens: 1, ...(costMicros === undefined ? {} : { costMicros }) },
    finishReason: "stop",
    provider: "fake",
    model: "test",
    latencyMs: 1,
    schemaValid: true,
    repairAttempts: 0,
    ...(rungUsed === undefined ? {} : { rungUsed }),
    fallbackDepth: 0,
    providerBlobs: null,
  };
}

function beginTracing(): void {
  ensureTracingFallback(
    RUN_SPAN.start({ "harness.run.id": runId, "harness.segment.id": segmentId }),
  );
}

async function execute(
  model: ModelPort,
  options: {
    readonly signal?: AbortSignal;
    readonly budgets?: ReturnType<typeof RunConfigSchema.parse>["budgets"];
    readonly tool?: ToolPort;
    readonly store?: InMemoryEventStore;
    readonly quotaService?: QuotaService;
  } = {},
) {
  const store = options.store ?? new InMemoryEventStore();
  const clock = new FakeClock(10);
  const result = await runLoop({
    recorder: new RunRecorder(store, runId, segmentId, 0, clock),
    clock,
    model,
    tool: options.tool ?? new FakeToolPort(),
    context: new NaiveContext(),
    ids: new SequentialIdGenerator(),
    goal: "structured result",
    configHash,
    budgets: options.budgets ?? RunConfigSchema.parse({}).budgets,
    policyVersion: "test.policy",
    signal: options.signal ?? new AbortController().signal,
    finalOutputSchema,
    ...(options.quotaService === undefined
      ? {}
      : {
          quotaService: options.quotaService,
          quotaIdentity: { role: "worker" },
        }),
  });
  return result;
}

describe("structured final output", () => {
  it("suspends when shutdown arrives with a successful structured response", async () => {
    beginTracing();
    const controller = new AbortController();
    const model: ModelPort = {
      complete: (_request, context) => {
        if (context.outputSchema !== undefined) {
          controller.abort("shutdown");
          return Promise.resolve(completion('{"answer":"done"}', "native"));
        }
        return Promise.resolve(completion("candidate"));
      },
    };

    const result = await execute(model, { signal: controller.signal });

    expect(result.status).toBe("suspended");
    expect(result.events.filter((event) => event.type === "run_status_changed")).toContainEqual(
      expect.objectContaining({ to: "suspended", reason: "shutdown" }),
    );
    expect(
      result.events.some(
        (event) => event.type === "run_status_changed" && event.to === "completed",
      ),
    ).toBe(false);
  });

  it("persists successful structured values without a value transform", async () => {
    beginTracing();
    const model: ModelPort = {
      complete: (_request, context) =>
        Promise.resolve(
          context.outputSchema === undefined
            ? completion("candidate")
            : {
                ...completion('{"answer":"done"}', "native"),
                enforcement: {
                  valid: true,
                  value: { answer: "done" },
                  rungUsed: "native",
                },
              },
        ),
    };

    const result = await execute(model);

    expect(result.status).toBe("completed");
    expect(
      result.events.findLast(
        (event) => event.type === "model_response" && event.rungUsed !== undefined,
      ),
    ).toMatchObject({ structuredValue: { answer: "done" } });
  });

  it("fails when the structured final call returns tool calls", async () => {
    beginTracing();
    const executeTool = vi.fn(() => Promise.resolve({ outcome: "ok" as const, result: null }));
    const tool = new FakeToolPort(
      new Map([["unexpected", { idempotent: true, timeoutMs: 1_000, execute: executeTool }]]),
    );
    const model: ModelPort = {
      complete: (_request, context) =>
        Promise.resolve(
          context.outputSchema === undefined
            ? completion("candidate")
            : {
                ...completion('{"answer":"done"}', "native"),
                parts: [
                  {
                    type: "tool_call",
                    callId: Id.parse("22222222222222222222222222"),
                    toolId: "unexpected",
                    args: {},
                  },
                  { type: "text", text: '{"answer":"done"}' },
                ],
              },
        ),
    };

    const result = await execute(model, { tool });

    expect(result.status).toBe("failed");
    expect(result.events.findLast((event) => event.type === "run_status_changed")).toMatchObject({
      to: "failed",
      reason: "result_invalid",
    });
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("fails final-call preflight when the preceding model step exhausts the step budget", async () => {
    beginTracing();
    const complete = vi.fn(() => Promise.resolve(completion("candidate")));
    const result = await execute(
      { complete },
      { budgets: RunConfigSchema.parse({ budgets: { maxSteps: 1 } }).budgets },
    );

    expect(result.status).toBe("failed");
    expect(complete).toHaveBeenCalledOnce();
    expect(result.events.some((event) => event.type === "budget_exceeded")).toBe(true);
  });

  it("checks quota before a structured final call after prior usage exhausts it", async () => {
    beginTracing();
    const store = new InMemoryEventStore();
    const quotaService = new QuotaService(
      QuotasConfigSchema.parse([
        { id: "worker", match: { role: ["worker"] }, dailyCostUsd: 0.000001 },
      ]),
      store,
      new FakeClock(10),
    );
    const complete = vi.fn(() => Promise.resolve(completion("candidate", undefined, 1)));

    const result = await execute({ complete }, { store, quotaService });

    expect(result.status).toBe("failed");
    expect(complete).toHaveBeenCalledOnce();
    expect(result.events).toContainEqual(
      expect.objectContaining({ type: "budget_exceeded", budget: "quota" }),
    );
  });

  it("accounts the structured final response and invalid-output usage", async () => {
    beginTracing();
    const store = new InMemoryEventStore();
    const quotaService = new QuotaService(
      QuotasConfigSchema.parse([{ id: "worker", match: { role: ["worker"] }, dailyCostUsd: 1 }]),
      store,
      new FakeClock(10),
    );
    let calls = 0;
    const complete: ModelPort["complete"] = () => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve(completion("candidate", undefined, 2));
      }
      return Promise.resolve({
        ...completion('{"answer":"done"}', "native", 3),
        enforcement: { valid: true, value: { answer: "done" }, rungUsed: "native" },
      });
    };

    const result = await execute({ complete }, { store, quotaService });

    expect(result.status).toBe("completed");
    await expect(store.readUsageLedger("worker", "day", [0])).resolves.toMatchObject([
      { costMicros: 5 },
    ]);
  });

  it("charges usage reported with an invalid structured response", async () => {
    beginTracing();
    const store = new InMemoryEventStore();
    const quotaService = new QuotaService(
      QuotasConfigSchema.parse([{ id: "worker", match: { role: ["worker"] }, dailyCostUsd: 1 }]),
      store,
      new FakeClock(10),
    );
    let calls = 0;
    const complete: ModelPort["complete"] = () => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve(completion("candidate", undefined, 2));
      }
      return Promise.reject(
        Object.assign(new Error("synthetic invalid output"), {
          code: "model_output_invalid",
          usage: { inputTokens: 1, outputTokens: 1, costMicros: 3 },
        }),
      );
    };

    const result = await execute({ complete }, { store, quotaService });

    expect(result.status).toBe("failed");
    await expect(store.readUsageLedger("worker", "day", [0])).resolves.toMatchObject([
      { costMicros: 5 },
    ]);
  });
});
