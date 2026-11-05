// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { createRuntime } from "@rovinos/core";
import type * as Core from "@rovinos/core";
import type { ModelCompletion, ModelPort, PolicyPort, Runtime, ToolPort } from "@rovinos/core";
import { FakeClock, Id } from "@rovinos/schemas";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineSuite } from "../load.js";
import { TrialSpecSchema } from "../trial.js";
import { InProcessExecutor } from "./inprocess.js";

vi.mock("@rovinos/core", async (importOriginal) => {
  const actual = await importOriginal<typeof Core>();
  return { ...actual, createRuntime: vi.fn(actual.createRuntime) };
});

const directories: string[] = [];
const runtimes: Runtime[] = [];
let onRuntime: ((runtime: Runtime) => Promise<void> | void) | undefined;
const callId = Id.parse("00000000000000000000000011");

async function trial(human = false) {
  const workDir = await mkdtemp(join(process.cwd(), ".inprocess-live-"));
  directories.push(workDir);
  const suite = defineSuite({
    schemaVersion: 1,
    tasks: [
      {
        id: "synthetic_live",
        input: { goal: "Complete a synthetic task." },
        budgets: { maxWallClockMs: 60_000 },
        ...(human
          ? {
              human: {
                rules: [{ match: { toolId: "fake.echo" }, decision: "approve" }],
                default: "deny",
              },
            }
          : {}),
        graders: [],
        tags: [],
      },
    ],
  });
  return TrialSpecSchema.parse({
    suite,
    task: suite.tasks[0],
    variantId: "baseline",
    variant: { id: "baseline" },
    trialIndex: 0,
    seed: 42,
    workDir: join(workDir, "trial"),
  });
}

function completion(callTool = false): ModelCompletion {
  return {
    provider: "synthetic",
    model: "synthetic",
    parts: callTool
      ? [{ type: "tool_call", callId, toolId: "fake.echo", args: {} }]
      : [{ type: "text", text: "done" }],
    providerBlobs: null,
    usage: { inputTokens: 1, outputTokens: 1 },
    finishReason: callTool ? "tool_calls" : "stop",
    latencyMs: 0,
    schemaValid: true,
    repairAttempts: 0,
    fallbackDepth: 0,
  };
}

function policy(decision: "ask" | "allow"): PolicyPort {
  return {
    version: "synthetic",
    decide: () => ({ decision, ruleId: "synthetic", reason: "synthetic", editable: [] }),
  };
}

function tool(execute: ToolPort["execute"]): ToolPort {
  return {
    getToolSpecs: () => [{ toolId: "fake.echo", description: "Synthetic tool", inputSchema: {} }],
    describe: () => ({ idempotent: true, timeoutMs: 1_000 }),
    execute,
  };
}

function runtimeSpy(method: "cancel" | "close" | "resume" | "resolveApproval" | "resolveInput") {
  const runtime = runtimes[0];
  if (runtime === undefined) {
    throw new Error("synthetic_runtime_missing");
  }
  return vi.spyOn(runtime, method);
}

beforeEach(async () => {
  const actual = await vi.importActual<typeof Core>("@rovinos/core");
  vi.mocked(createRuntime).mockImplementation(async (...args) => {
    const runtime = await actual.createRuntime(...args);
    runtimes.push(runtime);
    await onRuntime?.(runtime);
    vi.spyOn(runtime, "cancel");
    vi.spyOn(runtime, "close");
    vi.spyOn(runtime, "resume");
    vi.spyOn(runtime, "resolveApproval");
    vi.spyOn(runtime, "resolveInput");
    return runtime;
  });
});

afterEach(async () => {
  onRuntime = undefined;
  runtimes.splice(0);
  vi.restoreAllMocks();
  vi.mocked(createRuntime).mockClear();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("in-process live model lifecycle", () => {
  it.each(["system", "injected", "offline"])(
    "uses the %s clock for runtime model deadlines",
    async (mode) => {
      const observed: number[] = [];
      const model: ModelPort = {
        complete: (_request, context) => {
          observed.push(context.deadlineTs ?? 0);
          return Promise.resolve(completion());
        },
      };
      const clock = new FakeClock(2_000_000_000_000);
      const executor = new InProcessExecutor({
        ...(mode === "system" ? {} : { clock }),
        ...(mode === "offline" ? { model: () => model } : { liveModel: { model: () => model } }),
      });
      const before = Date.now();
      const result = await executor.run(await trial());

      expect(result.status).toBe("completed");
      let minimum: number;
      let maximum: number;
      if (mode === "system") {
        minimum = before + 60_000;
        maximum = Date.now() + 60_000;
      } else {
        minimum = (mode === "offline" ? 1_700_000_000_042 : clock.now()) + 60_000;
        maximum = minimum;
      }
      expect(observed).toHaveLength(1);
      expect(observed[0]).toBeGreaterThanOrEqual(minimum);
      expect(observed[0]).toBeLessThanOrEqual(maximum);
      expect(runtimeSpy("close")).toHaveBeenCalledOnce();
    },
  );

  it.each([false, true])("cancels an active tool (resumed: %s)", async (resumed) => {
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const model = vi.fn<ModelPort["complete"]>(() => Promise.resolve(completion(true)));
    let toolAborted = false;
    const execute: ToolPort["execute"] = async (_call, context) => {
      controller.abort();
      await new Promise<void>((resolve) => {
        if (context.signal.aborted) {
          resolve();
        } else {
          context.signal.addEventListener(
            "abort",
            () => {
              resolve();
            },
            { once: true },
          );
        }
      });
      toolAborted = context.signal.aborted;
      return { outcome: "error", result: null, errorCode: "cancelled" };
    };
    const executor = new InProcessExecutor({
      liveModel: { model: () => ({ complete: model }), signal: controller.signal },
      tool: () => tool(execute),
      policy: () => policy(resumed ? "ask" : "allow"),
    });
    const spec = await trial(resumed);
    const result = await executor.run(spec);

    expect(result.status).toBe("cancelled");
    expect(toolAborted).toBe(true);
    expect(model).toHaveBeenCalledOnce();
    expect(runtimeSpy("cancel")).toHaveBeenCalledWith(result.runId);
    expect(runtimeSpy("resume")).toHaveBeenCalledTimes(resumed ? 1 : 0);
    expect(runtimeSpy("close")).toHaveBeenCalledOnce();
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(executor.eventsFor(spec)).toContainEqual(
      expect.objectContaining({ type: "run_status_changed", to: "cancelled" }),
    );
  });

  it.each(["approval", "input"])("does not resolve or resume aborted human %s", async (kind) => {
    const controller = new AbortController();
    onRuntime = (runtime) => {
      const start = runtime.start.bind(runtime);
      vi.spyOn(runtime, "start").mockImplementation((...args) => {
        const handle = start(...args);
        return {
          ...handle,
          completion: handle.completion.then((result) => {
            expect(result.status).toBe("suspended");
            controller.abort();
            return result;
          }),
        };
      });
    };
    const execute: ToolPort["execute"] = async (_call, context) => {
      const result = await context.elicitation?.handleInputRequired({
        callId,
        serverId: "synthetic",
        round: 1,
        maxPerRun: 1,
        sensitiveInputKeys: [],
        inputRequests: [
          {
            inputKey: "synthetic",
            mode: "form",
            message: "Synthetic question",
            requestedSchema: { type: "object", properties: {} },
          },
        ],
      });
      expect(result?.kind).toBe("suspend");
      return { outcome: "ok", result: null, suspend: true, suspendReason: "awaiting_input" };
    };
    const executor = new InProcessExecutor({
      liveModel: {
        model: () => ({ complete: () => Promise.resolve(completion(true)) }),
        signal: controller.signal,
      },
      tool: () => tool(execute),
      policy: () => policy(kind === "approval" ? "ask" : "allow"),
    });
    const spec = await trial(true);
    const result = await executor.run(spec);

    expect(result.status).toBe("cancelled");
    expect(executor.eventsFor(spec)).toContainEqual(
      expect.objectContaining({
        type: kind === "approval" ? "approval_requested" : "input_requested",
      }),
    );
    expect(runtimeSpy("resolveApproval")).not.toHaveBeenCalled();
    expect(runtimeSpy("resolveInput")).not.toHaveBeenCalled();
    expect(runtimeSpy("resume")).not.toHaveBeenCalled();
    expect(runtimeSpy("cancel")).toHaveBeenCalledOnce();
    expect(runtimeSpy("close")).toHaveBeenCalledOnce();
  });

  it("does not resume when cancellation arrives during human resolution", async () => {
    const controller = new AbortController();
    onRuntime = (runtime) => {
      const resolve = runtime.resolveApproval.bind(runtime);
      vi.spyOn(runtime, "resolveApproval").mockImplementation(async (...args) => {
        const result = await resolve(...args);
        controller.abort();
        return result;
      });
    };
    const execute = vi.fn<ToolPort["execute"]>(() =>
      Promise.resolve({ outcome: "ok", result: null }),
    );
    const executor = new InProcessExecutor({
      liveModel: {
        model: () => ({ complete: () => Promise.resolve(completion(true)) }),
        signal: controller.signal,
      },
      tool: () => tool(execute),
      policy: () => policy("ask"),
    });

    expect((await executor.run(await trial(true))).status).toBe("cancelled");
    expect(runtimeSpy("resume")).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(runtimeSpy("cancel")).toHaveBeenCalledOnce();
    expect(runtimeSpy("close")).toHaveBeenCalledOnce();
  });

  it("rejects an already-aborted trial before constructing resources", async () => {
    const controller = new AbortController();
    controller.abort();
    const model = vi.fn(() => ({ complete: () => Promise.resolve(completion()) }));
    const executor = new InProcessExecutor({
      liveModel: { model, signal: controller.signal },
    });

    await expect(executor.run(await trial())).rejects.toMatchObject({
      code: "eval_live_cancelled",
    });
    expect(model).not.toHaveBeenCalled();
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it("closes without starting when cancellation arrives during runtime setup", async () => {
    const controller = new AbortController();
    const start = vi.fn<Runtime["start"]>();
    onRuntime = (runtime) => {
      vi.spyOn(runtime, "start").mockImplementation(start);
      controller.abort();
    };
    const executor = new InProcessExecutor({
      liveModel: {
        model: () => ({ complete: () => Promise.resolve(completion()) }),
        signal: controller.signal,
      },
    });

    await expect(executor.run(await trial())).rejects.toMatchObject({
      code: "eval_live_cancelled",
    });
    expect(start).not.toHaveBeenCalled();
    expect(runtimeSpy("close")).toHaveBeenCalledOnce();
  });

  it("closes a runtime when workspace preparation fails", async () => {
    const spec = await trial();
    onRuntime = () => rm(join(spec.workDir, "workspace"), { recursive: true });
    const executor = new InProcessExecutor({
      liveModel: { model: () => ({ complete: () => Promise.resolve(completion()) }) },
    });

    await expect(executor.run(spec)).rejects.toMatchObject({ code: "ENOENT" });
    expect(runtimeSpy("close")).toHaveBeenCalledOnce();
  });
});
