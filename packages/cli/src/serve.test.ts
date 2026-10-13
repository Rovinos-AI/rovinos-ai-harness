// SPDX-License-Identifier: Apache-2.0
import { HarnessConfigSchema } from "@harness/config";
import type { Runtime } from "@harness/core";
import { InMemoryEventStore } from "@harness/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliContext } from "./command.js";
import { ExitCode } from "./exit-codes.js";
import { createOutput } from "./output.js";
import { main } from "./main.js";
import { serveCommand } from "./serve.js";

const controlPlaneMocks = vi.hoisted(() => {
  const closeHttp = vi.fn(() => Promise.resolve());
  return {
    closeHttp,
    startHttp: vi.fn(() =>
      Promise.resolve({ endpoint: "http://127.0.0.1:3000/mcp", close: closeHttp }),
    ),
  };
});

vi.mock("@harness/control-plane", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@harness/control-plane")>()),
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
  const runtime: Runtime = {
    store,
    clock: { now: () => 1_000 },
    ids: { next: () => "00000000000000000000000000" },
    run: async () => {
      throw new Error("Run is not used by serve tests.");
    },
    continueRun: async () => {
      throw new Error("Continue is not used by serve tests.");
    },
    resume: async () => {
      throw new Error("Resume is not used by serve tests.");
    },
    cancel: async () => {
      throw new Error("Cancel is not used by serve tests.");
    },
    close: vi.fn(() => Promise.resolve()),
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
  return { context, runtime, stdout, stderr };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("serve command", () => {
  it("defaults to loopback HTTP and stops cleanly on SIGTERM", async () => {
    const { context, runtime, stdout, stderr } = createContext();
    const sigtermListeners = process.listenerCount("SIGTERM");
    const result = main(["serve"], context, [serveCommand]);
    const signalWait = waitForSignalListener("SIGTERM", sigtermListeners);
    const waitingForSignal = await Promise.race([
      result.then(() => false),
      signalWait.promise,
    ]);
    signalWait.cancel();
    if (waitingForSignal) {
      process.emit("SIGTERM");
    }

    expect(waitingForSignal).toBe(true);
    await expect(result).resolves.toBe(ExitCode.ok);
    expect(controlPlaneMocks.startHttp).toHaveBeenCalledWith(runtime.store, 3_000);
    expect(controlPlaneMocks.closeHttp).toHaveBeenCalledOnce();
    expect(process.listenerCount("SIGTERM")).toBe(sigtermListeners);
    expect(stdout).toEqual(["http://127.0.0.1:3000/mcp\n"]);
    expect(stderr).toEqual([]);
    expect(runtime.close).toHaveBeenCalledOnce();
  });

  it.each(["SIGINT", "SIGTERM"] as const)("stops stdio cleanly on %s", async (signal) => {
    const { context, runtime, stdout, stderr } = createContext();
    const sigintListeners = process.listenerCount("SIGINT");
    const sigtermListeners = process.listenerCount("SIGTERM");
    const result = main(["serve", "--stdio"], context, [serveCommand]);

    const baseline = signal === "SIGINT" ? sigintListeners : sigtermListeners;
    const signalWait = waitForSignalListener(signal, baseline);
    const waitingForSignal = await Promise.race([
      result.then(() => false),
      signalWait.promise,
    ]);
    signalWait.cancel();
    if (waitingForSignal) {
      process.emit(signal);
    }

    await expect(result).resolves.toBe(ExitCode.ok);
    expect(process.listenerCount("SIGINT")).toBe(sigintListeners);
    expect(process.listenerCount("SIGTERM")).toBe(sigtermListeners);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([]);
    expect(runtime.close).toHaveBeenCalledOnce();
  });

  it("rejects invalid transports, ports, and stdio JSON mode with error codes", async () => {
    const cases = [
      { args: ["serve", "--stdio", "--port", "3001"], code: "serve_options_invalid" },
      { args: ["serve", "--http", "--port", "65536"], code: "serve_port_invalid" },
      { args: ["--json", "serve", "--stdio"], code: "stdio_json_unsupported" },
    ] as const;

    for (const { args, code } of cases) {
      const { context, runtime, stdout, stderr } = createContext();
      await expect(main(args, context, [serveCommand])).resolves.toBe(ExitCode.failure);
      expect(stdout).toEqual([]);
      expect(stderr).toEqual([`${code}\n`]);
      expect(runtime.close).not.toHaveBeenCalled();
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
