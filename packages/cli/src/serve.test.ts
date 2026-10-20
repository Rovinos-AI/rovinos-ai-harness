// SPDX-License-Identifier: Apache-2.0
import { HarnessConfigSchema } from "@harness/config";
import type * as ControlPlane from "@harness/control-plane";
import { foldRunState, type Runtime } from "@harness/core";
import { Code, Id, Principal } from "@harness/schemas";
import {
  IdempotencyKeyHashSchema,
  InMemoryEventStore,
  type RunQueue,
  type RunQueueJob,
} from "@harness/store";
import { createEventBuilders } from "@harness/store/testing";
import { AuditingVaultResolver, InMemoryVault } from "@harness/vault";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliContext } from "./command.js";
import { ExitCode } from "./exit-codes.js";
import { createOutput } from "./output.js";
import { main } from "./main.js";
import { createControlPlaneOperations, serveCommand } from "./serve.js";

const controlPlaneMocks = vi.hoisted(() => {
  const closeHttp = vi.fn(() => Promise.resolve());
  let httpOptions: ControlPlane.ControlPlaneServerOptions | undefined;
  const closeStdio = vi.fn(() => Promise.resolve());
  return {
    closeHttp,
    closeStdio,
    // stdio is mocked like HTTP: these tests cover serve's signal handling, and the real server
    // loads the approval-app build, which CI's unit stage does not produce.
    startStdio: vi.fn(() => ({ close: closeStdio })),
    httpOptions: () => httpOptions,
    startHttp: vi.fn(
      (
        _store: InMemoryEventStore,
        _port: number,
        options?: ControlPlane.ControlPlaneServerOptions,
      ) => {
        httpOptions = options;
        return Promise.resolve({ endpoint: "http://127.0.0.1:3000/mcp", close: closeHttp });
      },
    ),
  };
});

vi.mock("@harness/control-plane", async (importOriginal) => ({
  ...(await importOriginal<typeof ControlPlane>()),
  startControlPlaneHttp: controlPlaneMocks.startHttp,
  startControlPlaneStdio: controlPlaneMocks.startStdio,
}));

function waitForSignalListener(
  signal: NodeJS.Signals,
  baseline: number,
): { promise: Promise<boolean>; cancel(): void } {
  let resolveWait: (value: boolean) => void = () => undefined;
  let timer: ReturnType<typeof setInterval>;
  const promise = new Promise<boolean>((resolve) => {
    resolveWait = resolve;
    let attempts = 0;
    timer = setInterval(() => {
      attempts += 1;
      if (process.listenerCount(signal) > baseline) {
        clearInterval(timer);
        resolve(true);
      } else if (attempts >= 1_000) {
        clearInterval(timer);
        resolve(false);
      }
    }, 10);
  });
  return {
    promise,
    cancel: () => {
      clearInterval(timer);
      resolveWait(false);
    },
  };
}

function createContext() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const store = new InMemoryEventStore();
  const closeRuntime = vi.fn(() => Promise.resolve());
  const queuedJob: RunQueueJob = {
    jobId: Id.parse("00000000000000000000000003"),
    kind: "resume",
    runId: Id.parse("00000000000000000000000001"),
    priority: 0,
    availableAt: 1_000,
    attempts: 0,
    maxAttempts: 5,
    createdAt: 1_000,
    updatedAt: 1_000,
  };
  const closeQueue = vi.fn(() => Promise.resolve());
  const queue: RunQueue = {
    enqueue: () => Promise.resolve(queuedJob),
    claim: () => Promise.resolve([]),
    heartbeat: () => Promise.resolve(true),
    complete: () => Promise.resolve(true),
    fail: () => Promise.resolve("retry"),
    release: () => Promise.resolve(true),
    getDeadLetter: () => Promise.resolve(undefined),
    close: closeQueue,
  };
  const runtime: Runtime = {
    store,
    queue,
    sandboxBackend: {
      exec: () => Promise.reject(new Error("Sandbox is not used by serve tests.")),
    },
    vault: new AuditingVaultResolver(new InMemoryVault(), () => undefined),
    keys: {
      currentKeyId: () => "test-key",
      getKey: () => Promise.resolve(new Uint8Array(32)),
    },
    clock: { now: () => 1_000 },
    ids: { next: () => "00000000000000000000000000" },
    run: () => Promise.reject(new Error("Run is not used by serve tests.")),
    start: () => ({
      runId: Id.parse("00000000000000000000000000"),
      started: Promise.resolve(),
      completion: Promise.reject(new Error("Start is not used by serve tests.")),
    }),
    continueRun: () => ({
      runId: Id.parse("00000000000000000000000000"),
      started: new Promise<void>(() => undefined),
      completion: new Promise<never>(() => undefined),
    }),
    resume: () => Promise.reject(new Error("Resume is not used by serve tests.")),
    resolveApproval: () => Promise.reject(new Error("Approval is not used by serve tests.")),
    cancel: () => Promise.reject(new Error("Cancel is not used by serve tests.")),
    hasPendingApproval: () => Promise.resolve(false),
    tokenizeAppContent: (_runId, content) => Promise.resolve(content),
    onAppContent: () => Promise.resolve(),
    close: closeRuntime,
  };
  const context: CliContext = {
    loadConfig: () => Promise.resolve(HarnessConfigSchema.parse({})),
    out: createOutput({
      stdout: (text) => {
        stdout.push(text);
      },
      stderr: (text) => {
        stderr.push(text);
      },
    }),
    clock: { now: () => 1_000 },
    openRunQueue: () => Promise.resolve(queue),
    createRuntime: () => runtime,
  };
  return { context, runtime, closeRuntime, closeQueue, stdout, stderr };
}

function startOperation(
  operations: ControlPlane.ControlPlaneOperations,
): NonNullable<ControlPlane.ControlPlaneOperations["startRun"]> {
  const startRun = operations.startRun;
  if (startRun === undefined) {
    throw new Error("Serve command did not configure start_run.");
  }
  return startRun;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("serve command", () => {
  it("defaults to loopback HTTP and stops cleanly on SIGTERM", async () => {
    const { context, runtime, closeRuntime, closeQueue, stdout, stderr } = createContext();
    const sigtermListeners = process.listenerCount("SIGTERM");
    const result = main(["serve"], context, [serveCommand]);
    const signalWait = waitForSignalListener("SIGTERM", sigtermListeners);
    const waitingForSignal = await Promise.race([result.then(() => false), signalWait.promise]);
    signalWait.cancel();
    if (waitingForSignal) {
      process.emit("SIGTERM");
    }

    expect(waitingForSignal).toBe(true);
    await expect(result).resolves.toBe(ExitCode.ok);
    expect(controlPlaneMocks.startHttp).toHaveBeenCalledTimes(1);
    expect(controlPlaneMocks.startHttp.mock.calls[0]?.[0]).toBe(runtime.store);
    expect(controlPlaneMocks.startHttp.mock.calls[0]?.[1]).toBe(3_000);
    const operations = controlPlaneMocks.httpOptions()?.operations;
    if (
      operations?.startRun === undefined ||
      operations.continueRun === undefined ||
      operations.resumeRun === undefined ||
      operations.cancelRun === undefined ||
      operations.resolveApproval === undefined
    ) {
      throw new Error("Serve command did not configure all control-plane operations.");
    }
    const builders = createEventBuilders();
    vi.spyOn(runtime.ids, "next").mockImplementation(() => builders.nextRunId());
    const start = vi.spyOn(runtime, "start").mockImplementation((_goal, options) => {
      const runId = options?.runId ?? builders.nextRunId();
      return {
        runId,
        started: runtime.store.append(runId, [builders.runCreated(runId)], 0).then(() => undefined),
        completion: new Promise<never>(() => undefined),
      };
    });
    const startOptions = {
      goal: "synthetic idempotent start",
      idempotencyKey: "synthetic-idempotency-key",
      requestedBy: Principal.parse("token.test"),
    };
    const firstStart = await operations.startRun(startOptions);
    const repeatedStart = await operations.startRun(startOptions);
    expect(firstStart).toEqual(repeatedStart);
    expect(start).toHaveBeenCalledOnce();
    const startWithoutKey = await operations.startRun({
      goal: "synthetic start without a key",
      requestedBy: Principal.parse("token.test"),
    });
    expect(startWithoutKey.status).toBe("pending");
    expect(start).toHaveBeenCalledTimes(2);
    const runId = Id.parse("00000000000000000000000001");
    const continuationRunId = builders.nextRunId();
    await runtime.store.append(continuationRunId, [builders.runCreated(continuationRunId)], 0);
    const continuationEvents = [];
    for await (const event of runtime.store.read(continuationRunId)) {
      continuationEvents.push(event);
    }
    const continuationState = foldRunState(continuationEvents);
    vi.spyOn(runtime, "continueRun").mockReturnValue({
      runId: continuationRunId,
      started: Promise.resolve(),
      completion: Promise.resolve({
        events: continuationEvents,
        status: "pending",
        approvalIds: [],
        state: continuationState,
      }),
    });
    await expect(
      operations.continueRun(runId, {
        goal: "synthetic continuation",
        requestedBy: Principal.parse("token.test"),
      }),
    ).resolves.toEqual({ runId: continuationRunId, status: "pending" });
    vi.spyOn(runtime, "continueRun").mockReturnValue({
      runId: continuationRunId,
      started: Promise.reject(new Error("synthetic continuation startup failure")),
      completion: new Promise<never>(() => undefined),
    });
    await expect(
      operations.continueRun(runId, {
        goal: "synthetic continuation without created event",
        requestedBy: Principal.parse("token.test"),
      }),
    ).rejects.toThrow("synthetic continuation startup failure");
    const abortSignal = new AbortController().signal;
    await expect(operations.resumeRun(runId, abortSignal, () => undefined)).rejects.toThrow();
    await expect(operations.cancelRun(runId)).rejects.toThrow();
    await expect(
      operations.resolveApproval({
        runId,
        approvalId: runId,
        decision: "deny",
        approverId: "token.test",
        reason: Code.parse("reviewed"),
      }),
    ).rejects.toThrow();
    expect(controlPlaneMocks.closeHttp.mock.calls).toHaveLength(1);
    expect(process.listenerCount("SIGTERM")).toBe(sigtermListeners);
    expect(stdout).toEqual(["http://127.0.0.1:3000/mcp\n"]);
    expect(stderr).toEqual([]);
    expect(closeRuntime.mock.calls).toHaveLength(1);
    expect(closeQueue).toHaveBeenCalledOnce();
  });

  it("isolates idempotency by requester and enforces filters on existing runs", async () => {
    const { runtime } = createContext();
    const operations = createControlPlaneOperations(runtime);
    const startRun = startOperation(operations);
    const builders = createEventBuilders();
    const firstRunId = Id.parse("00000000000000000000000010");
    const secondRunId = Id.parse("00000000000000000000000011");
    const duplicateCandidateId = Id.parse("00000000000000000000000012");
    const filteredCandidateId = Id.parse("00000000000000000000000013");
    vi.spyOn(runtime.ids, "next")
      .mockReturnValueOnce(firstRunId)
      .mockReturnValueOnce(duplicateCandidateId)
      .mockReturnValueOnce(secondRunId)
      .mockReturnValueOnce(filteredCandidateId);
    const start = vi.spyOn(runtime, "start").mockImplementation((_goal, options) => {
      const runId = options?.runId ?? builders.nextRunId();
      return {
        runId,
        started: runtime.store.append(runId, [builders.runCreated(runId)], 0).then(() => undefined),
        completion: new Promise<never>(() => undefined),
      };
    });
    const key = "requester-scoped-key";
    const first = await startRun({
      goal: "first request",
      idempotencyKey: key,
      requestedBy: Principal.parse("token.alpha"),
    });
    const duplicate = await startRun({
      goal: "same requester, different goal",
      idempotencyKey: key,
      requestedBy: Principal.parse("token.alpha"),
    });
    const otherRequester = await startRun({
      goal: "second requester",
      idempotencyKey: key,
      requestedBy: Principal.parse("token.beta"),
    });

    expect(duplicate).toEqual(first);
    expect(otherRequester.runId).not.toBe(first.runId);
    expect(start).toHaveBeenCalledTimes(2);
    await expect(
      startRun({
        goal: "filtered duplicate",
        idempotencyKey: key,
        requestedBy: Principal.parse("token.alpha"),
        allowedExistingRunIds: [duplicateCandidateId],
      }),
    ).rejects.toMatchObject({ code: "run_not_found" });
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("shares a single start among concurrent claims for the same requester", async () => {
    const { runtime } = createContext();
    const operations = createControlPlaneOperations(runtime);
    const startRun = startOperation(operations);
    const builders = createEventBuilders();
    const runId = Id.parse("00000000000000000000000010");
    const concurrentCandidateId = Id.parse("00000000000000000000000011");
    vi.spyOn(runtime.ids, "next")
      .mockReturnValueOnce(runId)
      .mockReturnValueOnce(concurrentCandidateId);
    let resolveStarted: (() => void) | undefined;
    let resolveStartCalled: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const startCalled = new Promise<void>((resolve) => {
      resolveStartCalled = resolve;
    });
    const start = vi.spyOn(runtime, "start").mockImplementation(() => {
      resolveStartCalled?.();
      return { runId, started, completion: new Promise<never>(() => undefined) };
    });
    const input = {
      goal: "concurrent request",
      idempotencyKey: "concurrent-key",
      requestedBy: Principal.parse("token.concurrent"),
    };

    const first = startRun(input);
    await startCalled;
    const second = startRun(input);
    await runtime.store.append(runId, [builders.runCreated(runId)], 0);
    resolveStarted?.();

    const results = await Promise.all([first, second]);
    expect(results[0]).toEqual(results[1]);
    expect(start).toHaveBeenCalledOnce();
  });

  it("releases an idempotency claim after a failed start with no durable events", async () => {
    const { runtime } = createContext();
    const operations = createControlPlaneOperations(runtime);
    const startRun = startOperation(operations);
    const builders = createEventBuilders();
    const failedRunId = builders.nextRunId();
    const recoveredRunId = builders.nextRunId();
    vi.spyOn(runtime.ids, "next")
      .mockReturnValueOnce(failedRunId)
      .mockReturnValueOnce(recoveredRunId);
    const start = vi.spyOn(runtime, "start");
    start
      .mockImplementationOnce(() => ({
        runId: failedRunId,
        started: Promise.reject(new Error("synthetic start failure")),
        completion: new Promise<never>(() => undefined),
      }))
      .mockImplementationOnce((_goal, options) => {
        const runId = options?.runId ?? recoveredRunId;
        return {
          runId,
          started: runtime.store
            .append(runId, [builders.runCreated(runId)], 0)
            .then(() => undefined),
          completion: new Promise<never>(() => undefined),
        };
      });
    const input = {
      goal: "retry request",
      idempotencyKey: "released-key",
      requestedBy: Principal.parse("token.retry"),
    };

    await expect(startRun(input)).rejects.toThrow("synthetic start failure");
    await expect(startRun(input)).resolves.toMatchObject({ runId: recoveredRunId });
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("takes over a stale idempotency claim when its run was never written", async () => {
    const { runtime } = createContext();
    const operations = createControlPlaneOperations(runtime);
    const startRun = startOperation(operations);
    const builders = createEventBuilders();
    const orphanRunId = builders.nextRunId();
    const replacementRunId = builders.nextRunId();
    const requester = Principal.parse("token.takeover");
    const key = "takeover-key";
    const keyHash = IdempotencyKeyHashSchema.parse(
      createHash("sha256")
        .update("harness/control-plane/idempotency/v1\0")
        .update(requester)
        .update("\0")
        .update(key)
        .digest("hex"),
    );
    await runtime.store.claimIdempotencyKey(keyHash, orphanRunId, 0);
    vi.spyOn(runtime.clock, "now").mockReturnValue(60_000);
    vi.spyOn(runtime.ids, "next").mockReturnValue(replacementRunId);
    const start = vi.spyOn(runtime, "start").mockImplementation((_goal, options) => {
      const runId = options?.runId ?? replacementRunId;
      return {
        runId,
        started: runtime.store.append(runId, [builders.runCreated(runId)], 0).then(() => undefined),
        completion: new Promise<never>(() => undefined),
      };
    });

    await expect(
      startRun({ goal: "take over", idempotencyKey: key, requestedBy: requester }),
    ).resolves.toMatchObject({ runId: replacementRunId, status: "pending" });
    expect(start).toHaveBeenCalledOnce();
  });

  it.each(["SIGINT", "SIGTERM"] as const)("stops stdio cleanly on %s", async (signal) => {
    const { context, closeRuntime, closeQueue, stdout, stderr } = createContext();
    const sigintListeners = process.listenerCount("SIGINT");
    const sigtermListeners = process.listenerCount("SIGTERM");
    const result = main(["serve", "--stdio"], context, [serveCommand]);

    const baseline = signal === "SIGINT" ? sigintListeners : sigtermListeners;
    const signalWait = waitForSignalListener(signal, baseline);
    const waitingForSignal = await Promise.race([result.then(() => false), signalWait.promise]);
    signalWait.cancel();
    if (waitingForSignal) {
      process.emit(signal);
    }

    await expect(result).resolves.toBe(ExitCode.ok);
    expect(process.listenerCount("SIGINT")).toBe(sigintListeners);
    expect(process.listenerCount("SIGTERM")).toBe(sigtermListeners);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([]);
    expect(closeRuntime.mock.calls).toHaveLength(1);
    expect(closeQueue).toHaveBeenCalledOnce();
  });

  it("rejects invalid transports, ports, and stdio JSON mode with error codes", async () => {
    const cases = [
      { args: ["serve", "--stdio", "--port", "3001"], code: "serve_options_invalid" },
      { args: ["serve", "--http", "--port", "65536"], code: "serve_port_invalid" },
      { args: ["--json", "serve", "--stdio"], code: "stdio_json_unsupported" },
    ] as const;

    for (const { args, code } of cases) {
      const { context, closeRuntime, stdout, stderr } = createContext();
      await expect(main(args, context, [serveCommand])).resolves.toBe(ExitCode.usage);
      expect(stdout).toEqual([]);
      expect(stderr).toEqual([`${code}\n`]);
      expect(closeRuntime.mock.calls).toHaveLength(0);
    }
  });

  it("lists both serving modes and the optional HTTP port in help", async () => {
    const { context, stdout } = createContext();

    await expect(main(["serve", "--help"], context, [serveCommand])).resolves.toBe(ExitCode.ok);

    expect(stdout.join("")).toContain("--stdio");
    expect(stdout.join("")).toContain("--http");
    expect(stdout.join("")).toContain("--port <port>");
  });
});
