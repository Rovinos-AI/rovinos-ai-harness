// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { HarnessConfigSchema } from "@harness/config";
import {
  Checkpointer,
  NaiveContext,
  RunRecorder,
  createRuntime,
  foldRunState,
  requestApproval,
  resolveApproval,
  RUN_SPAN,
  type ModelCompletion,
  type ModelPort,
  type ModelRequest,
  type RunLoopResult,
  type ShutdownProcessLike,
  type ToolPort,
} from "@harness/core";
import { FakeModelPort, FakeToolPort } from "@harness/core/testing";
import {
  FakeClock,
  Event as EventSchema,
  Id,
  RunResultSchema,
  Sha256Hex,
  parseJson,
  type Event,
} from "@harness/schemas";
import { InMemoryEventStore } from "@harness/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCommandRuntime, type CliContext } from "../command.js";
import { ExitCode } from "../exit-codes.js";
import { createOutput } from "../output.js";
import { main } from "../main.js";
import { cancelCommand } from "./cancel.js";
import { inspectCommand } from "./inspect.js";
import { resumeCommand } from "./resume.js";
import { runCommand } from "./run.js";

class TestShutdownProcess implements ShutdownProcessLike {
  exitCode: number | undefined;
  private readonly listeners = new Map<"SIGINT" | "SIGTERM", (() => void)[]>();

  on(signal: "SIGINT" | "SIGTERM", listener: () => void): this {
    this.listeners.set(signal, [...(this.listeners.get(signal) ?? []), listener]);
    return this;
  }

  removeListener(signal: "SIGINT" | "SIGTERM", listener: () => void): this {
    this.listeners.set(
      signal,
      (this.listeners.get(signal) ?? []).filter((registered) => registered !== listener),
    );
    return this;
  }

  exit(code: number): void {
    this.exitCode = code;
  }

  emit(signal: "SIGINT" | "SIGTERM"): void {
    for (const listener of this.listeners.get(signal) ?? []) {
      listener();
    }
  }
}

const config = HarnessConfigSchema.parse({});
const completion = (content: string): ModelCompletion => ({
  parts: [{ type: "text", text: content }],
  usage: { inputTokens: 2, outputTokens: 3 },
  finishReason: "stop",
  provider: "test",
  model: "script",
  latencyMs: 1,
  schemaValid: true,
  repairAttempts: 0,
  fallbackDepth: 0,
  providerBlobs: null,
});

interface CliHarness {
  readonly context: CliContext;
  readonly stdout: string[];
  readonly stderr: string[];
  readonly store: InMemoryEventStore;
  readonly ids: ReturnType<typeof createIds>;
  readonly clock: FakeClock;
  readonly shutdown: TestShutdownProcess;
}

function createIds() {
  return new (class {
    private value = 0;

    next(): Id {
      const digits = String(this.value).padStart(26, "0");
      this.value += 1;
      return Id.parse(digits);
    }
  })();
}

function createHarness(
  model: ModelPort = new FakeModelPort([completion("answer")]),
  runConfig = config,
  tool: ToolPort = new FakeToolPort(),
  shutdown = new TestShutdownProcess(),
  resumeResult?: RunLoopResult,
): CliHarness {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const out = createOutput({
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
  });
  const store = new InMemoryEventStore();
  const ids = createIds();
  const clock = new FakeClock(1_000);
  const context: CliContext = {
    loadConfig: () => Promise.resolve(runConfig),
    out,
    clock,
    createRuntime: async (runtimeConfig, overrides) => {
      const runtime = await createRuntime(runtimeConfig, {
        store,
        ids,
        clock,
        context: new NaiveContext(),
        tool,
        processLike: shutdown,
        model: overrides?.model ?? model,
      });
      return resumeResult === undefined
        ? runtime
        : { ...runtime, resume: () => Promise.resolve(resumeResult) };
    },
  };
  return { context, stdout, stderr, store, ids, clock, shutdown };
}

let temporaryDirectory = "";

async function createFile(name: string, contents: string): Promise<string> {
  const path = join(temporaryDirectory, name);
  await writeFile(path, contents, { encoding: "utf8" });
  return path;
}

async function seedPendingApproval(harness: CliHarness): Promise<{
  readonly runId: Id;
  readonly approvalId: Id;
  readonly events: readonly Event[];
}> {
  const runId = harness.ids.next();
  const segmentId = harness.ids.next();
  const callId = harness.ids.next();
  const approvalId = harness.ids.next();
  const recorder = new RunRecorder(harness.store, runId, segmentId, 0, harness.clock);
  let lastEvent: Event | undefined;
  await recorder.withStepSpan(RUN_SPAN, {}, async () => {
    const events = await recorder.recordBatch([
      {
        type: "run_created",
        v: 1,
        configHash: Sha256Hex.parse("a".repeat(64)),
        policyVersion: "test",
      },
      {
        type: "run_status_changed",
        v: 1,
        from: "pending",
        to: "running",
        reason: "start",
      },
      {
        type: "model_request",
        v: 1,
        requestId: harness.ids.next(),
        provider: "test",
        model: "script",
        messages: [{ role: "user", parts: [{ type: "text", text: "approval test" }] }],
      },
      {
        type: "tool_intent",
        v: 1,
        callId,
        toolId: "test_tool",
        idempotent: false,
        policyDecision: "ask",
        argsHash: Sha256Hex.parse("b".repeat(64)),
        args: { value: "<EMAIL_1>" },
      },
    ]);
    lastEvent = events.at(-1);
    if (lastEvent === undefined) {
      throw new Error("Expected a seeded tool intent.");
    }
    return lastEvent;
  });
  const state = foldRunState(await readEvents(harness.store, runId));
  const checkpointer = new Checkpointer({
    recorder,
    runId,
    context: new NaiveContext(),
    ids: harness.ids,
    clock: harness.clock,
  });
  await requestApproval(recorder, {
    approvalId,
    callId,
    payload: { reason: "human decision" },
    state,
    checkpointer,
  });
  return { runId, approvalId, events: await readEvents(harness.store, runId) };
}

function runResult(status: RunLoopResult["status"], events: readonly Event[]): RunLoopResult {
  const first = events[0];
  if (first === undefined) {
    throw new Error("Expected events for a run result.");
  }
  return { status, state: foldRunState(events), approvalIds: [], events };
}

async function readEvents(store: InMemoryEventStore, runId: Id): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of store.read(runId)) {
    events.push(event);
  }
  return events;
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (temporaryDirectory !== "") {
    await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = "";
  }
});

describe("run, resume, and inspect CLI commands", () => {
  it("runs a JSON input with a scripted fake model and emits one JSON result", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "harness-cli-run-"));
    const inputPath = await createFile(
      "input.json",
      '{"goal":"say hello","metadata":{"source":"test"}}',
    );
    const scriptPath = await createFile("model.json", '[{"content":"hello"}]');
    const harness = createHarness();

    const code = await main(
      ["--json", "run", "--input", inputPath, "--fake-model", scriptPath],
      harness.context,
      [runCommand],
    );

    expect(code).toBe(ExitCode.ok);
    const invalidHarness = createHarness();
    Object.defineProperty(process, "stdin", {
      configurable: true,
      value: Readable.from([42]),
    });
    const invalidCode = await main(["run", "--input", "-"], invalidHarness.context, [runCommand]);
    expect(invalidCode).toBe(ExitCode.failure);
    expect(invalidHarness.stderr).toEqual(["input_invalid\n"]);
    expect(harness.stdout).toHaveLength(1);
    expect(harness.stdout[0]).toMatch(/"status":"completed"/u);
    expect(harness.stderr).toEqual(["00000000000000000000000000\n"]);
  });

  it("reads JSON input from standard input", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "harness-cli-stdin-"));
    const scriptPath = await createFile("model.json", '[{"content":"stdin"}]');
    const harness = createHarness();
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process, "stdin");
    if (stdinDescriptor === undefined) {
      throw new Error("Expected standard input descriptor.");
    }
    Object.defineProperty(process, "stdin", {
      configurable: true,
      value: Readable.from(['{"goal":"from ', Buffer.from("stdin"), '"}']),
    });
    try {
      const code = await main(
        ["--json", "run", "--input", "-", "--fake-model", scriptPath],
        harness.context,
        [runCommand],
      );

      expect(code).toBe(ExitCode.ok);
    } finally {
      Object.defineProperty(process, "stdin", stdinDescriptor);
    }
  });

  it("returns suspended on shutdown and keeps event content hidden by default", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "harness-cli-shutdown-"));
    const shutdown = new TestShutdownProcess();
    let signalOnNextCall = true;
    const requests: ModelRequest[] = [];
    const model: ModelPort = {
      complete: (request) => {
        requests.push(request);
        if (signalOnNextCall) {
          signalOnNextCall = false;
          shutdown.emit("SIGTERM");
        }
        return Promise.resolve(completion("<EMAIL_1>"));
      },
    };
    const harness = createHarness(model, config, new FakeToolPort(), shutdown);
    const inputPath = await createFile("input.json", '{"goal":"wait"}');

    const runCode = await main(["--json", "run", "--input", inputPath], harness.context, [
      runCommand,
    ]);
    const suspendedRunResult = parseJson(RunResultSchema, harness.stdout[0] ?? "");
    const runId = suspendedRunResult.runId;
    harness.stdout.length = 0;
    harness.stderr.length = 0;

    const inspectCode = await main(["--json", "inspect", runId], harness.context, [inspectCommand]);

    expect(runCode).toBe(ExitCode.suspended);
    expect(inspectCode).toBe(ExitCode.ok);
    expect(harness.stdout.join("")).not.toContain("<EMAIL_1>");
    expect(harness.stderr.join("")).toContain('"status": "suspended"');

    harness.stdout.length = 0;
    harness.stderr.length = 0;
    const resumeCode = await main(["--json", "resume", runId], harness.context, [resumeCommand]);

    expect(resumeCode).toBe(ExitCode.ok);
    expect(requests.at(-1)?.messages).toContainEqual({
      role: "user",
      parts: [{ type: "text", text: '{"goal":"wait"}' }],
    });
  });

  it("shows pending approvals, warns before exposing content, and resumes after approval", async () => {
    const tool = new FakeToolPort(
      new Map([
        [
          "test_tool",
          {
            idempotent: false,
            timeoutMs: 1_000,
            execute: () => Promise.resolve({ outcome: "ok", result: { approved: true } }),
          },
        ],
      ]),
    );
    const harness = createHarness(new FakeModelPort([completion("finished")]), config, tool);
    const { runId, approvalId, events } = await seedPendingApproval(harness);
    const inspectCode = await main(["--json", "inspect", runId], harness.context, [inspectCommand]);
    const hidden = harness.stdout.join("");

    expect(inspectCode).toBe(ExitCode.ok);
    expect(hidden).toContain('"toolId":"test_tool"');
    expect(hidden).not.toContain("<EMAIL_1>");
    harness.stdout.length = 0;
    harness.stderr.length = 0;

    const revealCode = await main(["--json", "inspect", runId, "--show-content"], harness.context, [
      inspectCommand,
    ]);
    expect(revealCode).toBe(ExitCode.ok);
    expect(harness.stdout.join("")).toContain("<EMAIL_1>");
    expect(harness.stderr[0]).toBe("content_may_be_sensitive\n");

    await resolveApproval(harness.store, runId, approvalId, "approve", undefined, harness.clock);
    const resumeCode = await main(["--json", "resume", runId], harness.context, [resumeCommand]);

    expect(resumeCode).toBe(ExitCode.ok);
    expect(harness.stdout.at(-1)).toContain('"status":"completed"');
    expect(tool.calls).toHaveLength(1);

    const budgetEvent = EventSchema.parse({
      runId,
      seq: events.length,
      ts: harness.clock.now(),
      v: 1,
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      segmentId: events[0]?.segmentId,
      type: "budget_exceeded",
      budget: "steps",
      limit: 1,
      observed: 2,
    });
    const failedBudget = runResult("failed", [...events, budgetEvent]);
    const failedHarness = createHarness(
      new FakeModelPort([]),
      config,
      new FakeToolPort(),
      new TestShutdownProcess(),
      failedBudget,
    );
    const budgetCode = await main(["resume", runId], failedHarness.context, [resumeCommand]);
    expect(budgetCode).toBe(ExitCode.budgetExceeded);

    const suspendedHarness = createHarness(
      new FakeModelPort([]),
      config,
      new FakeToolPort(),
      new TestShutdownProcess(),
      runResult("suspended", events),
    );
    expect(await main(["resume", runId], suspendedHarness.context, [resumeCommand])).toBe(
      ExitCode.suspended,
    );

    const activeHarness = createHarness(
      new FakeModelPort([]),
      config,
      new FakeToolPort(),
      new TestShutdownProcess(),
      runResult("running", events),
    );
    expect(await main(["resume", runId], activeHarness.context, [resumeCommand])).toBe(
      ExitCode.failure,
    );
  });

  it("cancels a suspended run and returns failure for an already-terminal run", async () => {
    const harness = createHarness();
    const { runId } = await seedPendingApproval(harness);

    const cancelCode = await main(["--json", "cancel", runId], harness.context, [cancelCommand]);

    expect(cancelCode).toBe(ExitCode.ok);
    expect(parseJson(RunResultSchema, harness.stdout.join(""))).toEqual({
      runId,
      status: "cancelled",
    });
    harness.stdout.length = 0;
    harness.stderr.length = 0;

    const alreadyTerminalCode = await main(["cancel", runId], harness.context, [cancelCommand]);

    expect(alreadyTerminalCode).toBe(ExitCode.failure);
    expect(harness.stderr).toEqual(["run_already_terminal\n"]);
    expect(harness.stdout).toEqual([]);
  });

  it("maps a budget failure and a generic model failure to their stable exit codes", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "harness-cli-budget-"));
    const inputPath = await createFile("input.json", '{"goal":"budget"}');
    const scriptPath = await createFile(
      "budget.json",
      '[{"content":"call tool","toolCalls":[{"callId":"22222222222222222222222222","toolId":"missing_tool","args":{}}]}]',
    );
    const budgetConfig = HarnessConfigSchema.parse({ run: { budgets: { maxSteps: 1 } } });
    const budgetHarness = createHarness(undefined, budgetConfig);
    const budgetCode = await main(
      ["run", "--input", inputPath, "--fake-model", scriptPath],
      budgetHarness.context,
      [runCommand],
    );

    expect(budgetCode).toBe(ExitCode.budgetExceeded);

    const emptyScriptPath = await createFile("empty.json", "[]");
    const failedHarness = createHarness();
    const failedCode = await main(
      ["run", "--input", inputPath, "--fake-model", emptyScriptPath],
      failedHarness.context,
      [runCommand],
    );
    expect(failedCode).toBe(ExitCode.failure);
  });

  it("creates a runtime lazily when the CLI context has no runtime factory", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "harness-runtime-"));
    const stdout: string[] = [];
    const stderr: string[] = [];
    const runtime = await createCommandRuntime(
      {
        loadConfig: () => Promise.resolve(config),
        out: createOutput({
          stdout: (text) => stdout.push(text),
          stderr: (text) => stderr.push(text),
        }),
        clock: new FakeClock(1_000),
      },
      config,
      { dataDir: temporaryDirectory, model: new FakeModelPort([completion("runtime")]) },
    );

    const result = await runtime.run("runtime");
    await runtime.close();

    expect(result.status).toBe("completed");
    expect(await readFile(join(temporaryDirectory, "harness.db"))).toBeInstanceOf(Buffer);
  });

  it("maps a missing original run input to the failure exit code", async () => {
    const harness = createHarness();
    const runId = Id.parse("00000000000000000000000000");

    const code = await main(["resume", runId], harness.context, [resumeCommand]);

    expect(code).toBe(ExitCode.failure);
    expect(harness.stderr).toEqual(["run_input_missing\n"]);
  });

  it("uses default CLI context and honors an explicit config path", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "harness-cli-default-"));
    vi.stubEnv("HARNESS_DATA_DIR", join(temporaryDirectory, "data"));
    const inputPath = await createFile("input.json", '{"goal":"default context"}');
    const scriptPath = await createFile("model.json", '[{"content":"default"}]');
    const configPath = await createFile("harness.yaml", "{}");

    const defaultCode = await main([
      "--json",
      "run",
      "--input",
      inputPath,
      "--fake-model",
      scriptPath,
    ]);
    const configuredCode = await main([
      "--json",
      "--config",
      configPath,
      "run",
      "--input",
      inputPath,
      "--fake-model",
      scriptPath,
    ]);
    expect(defaultCode).toBe(ExitCode.ok);
    expect(configuredCode).toBe(ExitCode.ok);
    expect(configuredCode).toBe(ExitCode.ok);
    expect(await readFile(join(temporaryDirectory, "data", "harness.db"))).toBeInstanceOf(Buffer);
  });
});
