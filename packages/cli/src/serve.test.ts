// SPDX-License-Identifier: Apache-2.0
import { HarnessConfigSchema } from "@harness/config";
import type * as ControlPlane from "@harness/control-plane";
import type { Runtime } from "@harness/core";
import { Code, Id } from "@harness/schemas";
import { InMemoryEventStore } from "@harness/store";
import { AuditingVaultResolver, InMemoryVault } from "@harness/vault";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliContext } from "./command.js";
import { ExitCode } from "./exit-codes.js";
import { createOutput } from "./output.js";
import { main } from "./main.js";
import { serveCommand } from "./serve.js";

const controlPlaneMocks = vi.hoisted(() => {
  const closeHttp = vi.fn(() => Promise.resolve());
  let httpOptions: ControlPlane.ControlPlaneServerOptions | undefined;
  return {
    closeHttp,
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
  const runtime: Runtime = {
    store,
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
    continueRun: () => Promise.reject(new Error("Continue is not used by serve tests.")),
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
    createRuntime: () => runtime,
  };
  return { context, runtime, closeRuntime, stdout, stderr };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("serve command", () => {
  it("defaults to loopback HTTP and stops cleanly on SIGTERM", async () => {
    const { context, runtime, closeRuntime, stdout, stderr } = createContext();
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
      operations?.resumeRun === undefined ||
      operations.cancelRun === undefined ||
      operations.resolveApproval === undefined
    ) {
      throw new Error("Serve command did not configure all control-plane operations.");
    }
    const runId = Id.parse("00000000000000000000000001");
    const abortSignal = new AbortController().signal;
    await expect(operations.resumeRun(runId, abortSignal, () => undefined)).rejects.toThrow();
    await expect(operations.cancelRun(runId)).rejects.toThrow();
    await expect(
      operations.resolveApproval({
        runId,
        approvalId: runId,
        decision: "deny",
        reason: Code.parse("reviewed"),
      }),
    ).rejects.toThrow();
    expect(controlPlaneMocks.closeHttp.mock.calls).toHaveLength(1);
    expect(process.listenerCount("SIGTERM")).toBe(sigtermListeners);
    expect(stdout).toEqual(["http://127.0.0.1:3000/mcp\n"]);
    expect(stderr).toEqual([]);
    expect(closeRuntime.mock.calls).toHaveLength(1);
  });

  it.each(["SIGINT", "SIGTERM"] as const)("stops stdio cleanly on %s", async (signal) => {
    const { context, closeRuntime, stdout, stderr } = createContext();
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
