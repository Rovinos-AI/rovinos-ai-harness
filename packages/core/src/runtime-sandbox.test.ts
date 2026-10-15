// SPDX-License-Identifier: Apache-2.0
import { existsSync } from "node:fs";
import { mkdtemp, rm, stat, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Code,
  FakeClock,
  Id,
  RunConfigSchema,
  SandboxConfigSchema,
  SecretRefSchema,
  SequentialIdGenerator,
} from "@harness/schemas";
import { InMemoryEventStore } from "@harness/store";
import { InProcessBackend, RemoteSandboxBackend, type SandboxBackend } from "@harness/sandbox";
import { SqliteVault } from "@harness/vault";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntime } from "./runtime.js";
import { withSandboxLease } from "./runtime-lifecycle.js";
import type { ModelCompletion, ToolPort } from "./ports.js";
import { FakeModelPort } from "./testing/fake-model.js";
import { allowAllPolicy } from "./testing/allow-policy.js";

const toolId = Code.parse("sandbox.probe");
const run = RunConfigSchema.parse({});
const canary = "synthetic-sandbox-output-canary";
const result = {
  exitCode: 0,
  stdout: canary,
  stderr: "",
  stdoutBytes: canary.length,
  stderrBytes: 0,
  truncated: false,
  timedOut: false,
  durationMs: 1,
};

function completion(parts: ModelCompletion["parts"]): ModelCompletion {
  return {
    parts,
    usage: { inputTokens: 1, outputTokens: 1 },
    finishReason: parts.some((part) => part.type === "tool_call") ? "tool_calls" : "stop",
    provider: "synthetic",
    model: "synthetic",
    latencyMs: 0,
    schemaValid: true,
    repairAttempts: 0,
    fallbackDepth: 0,
    providerBlobs: null,
  };
}

function requestUrl(input: RequestInfo | URL): URL {
  if (input instanceof URL) {
    return input;
  }
  return typeof input === "string" ? new URL(input) : new URL(input.url);
}

function model(): FakeModelPort {
  return new FakeModelPort([
    completion([
      { type: "tool_call", callId: Id.parse("11111111111111111111111111"), toolId, args: {} },
    ]),
    completion([{ type: "text", text: "completed" }]),
  ]);
}

function metadataTool(backend: SandboxBackend, remote: boolean): ToolPort {
  return {
    describe: (id) => (id === toolId ? { idempotent: false, timeoutMs: 5000 } : undefined),
    execute: async (_call, context) => {
      const output = await backend.exec(
        context.runId,
        {
          argv: [
            remote ? "node" : process.execPath,
            "-e",
            'process.stdout.write(process.env.HARNESS_SANDBOX_CANARY ?? "scrubbed")',
          ],
          timeoutMs: 2000,
          limits: { memoryMb: 128, pids: 16, outputBytes: 1024, cpuSeconds: 5 },
        },
        context.signal,
      );
      return { outcome: "ok", result: { exitCode: output.exitCode, bytes: output.stdoutBytes } };
    },
  };
}

function overrides() {
  return {
    store: new InMemoryEventStore(),
    transientVault: true,
    clock: new FakeClock(100),
    ids: new SequentialIdGenerator(),
    flushTelemetry: () => Promise.resolve(),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("createRuntime sandbox composition", () => {
  it("preserves the operation outcome when lease cleanup fails", async () => {
    const backend: SandboxBackend = {
      exec: vi.fn(),
      acquireLease: () => Promise.resolve(),
      releaseLease: () => Promise.reject(new Error("synthetic cleanup failure")),
    };
    const value = { status: "completed" };
    await expect(
      withSandboxLease(backend, Id.parse("00000000000000000000000042"), () =>
        Promise.resolve(value),
      ),
    ).resolves.toBe(value);

    const operationError = new Error("synthetic operation failure");
    await expect(
      withSandboxLease(backend, Id.parse("00000000000000000000000042"), () =>
        Promise.reject(operationError),
      ),
    ).rejects.toBe(operationError);
  });

  // threat: T-12
  it("creates a private workspace under the data directory and rejects outside paths", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "runtime-sandbox-workspace-"));
    const runtime = await createRuntime({ run }, { ...overrides(), dataDir });
    try {
      const execution = await runtime.sandboxBackend.exec(
        Id.parse("00000000000000000000000041"),
        {
          argv: [process.execPath, "-e", "process.stdout.write(process.cwd())"],
          timeoutMs: 2000,
          limits: { memoryMb: 128, pids: 16, outputBytes: 1024, cpuSeconds: 5 },
        },
        new AbortController().signal,
      );
      const workspaceRoot = join(dataDir, "workspaces");
      // macOS resolves /var to /private/var; compare canonical paths.
      expect(execution.stdout).toBe(
        await realpath(join(workspaceRoot, Id.parse("00000000000000000000000041"), "project")),
      );
      expect((await stat(workspaceRoot)).mode & 0o777).toBe(0o700);
      await expect(
        runtime.sandboxBackend.exec(
          Id.parse("00000000000000000000000041"),
          {
            argv: [process.execPath, "-e", ""],
            cwd: "../outside",
            timeoutMs: 2000,
            limits: { memoryMb: 128, pids: 16, outputBytes: 1024, cpuSeconds: 5 },
          },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: "sandbox_workspace_path_invalid" });
    } finally {
      await runtime.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  // threat: T-05
  // threat: T-18
  it.each([
    {
      sandbox: {
        egress: { allow: [{ host: "api.example.com", ports: [443] }] },
      },
    },
    {
      sandbox: {
        runner: { url: "http://sandbox-runner:8080", token: SecretRefSchema.parse("env:RUNNER") },
      },
    },
  ])("closes the vault when sandbox configuration fails closed", async ({ sandbox }) => {
    const dataDir = await mkdtemp(join(tmpdir(), "runtime-sandbox-failure-"));
    const closeVault = vi.spyOn(SqliteVault.prototype, "close");
    try {
      await expect(
        createRuntime(
          { run, sandbox: SandboxConfigSchema.parse(sandbox) },
          {
            dataDir,
            transientVault: true,
            clock: new FakeClock(100),
            ids: new SequentialIdGenerator(),
          },
        ),
      ).rejects.toMatchObject({ code: "sandbox_runner_config_invalid" });
      expect(closeVault).toHaveBeenCalledOnce();
      expect(existsSync(join(dataDir, "harness.db"))).toBe(false);
    } finally {
      closeVault.mockRestore();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  // threat: T-10
  // threat: T-11
  it.each([false, true])(
    "passes one configured backend to the tool port and records only result metadata (remote=%s)",
    async (remote) => {
      vi.stubEnv("HARNESS_SANDBOX_CANARY", canary);
      const fetcher = vi.fn((input: RequestInfo | URL) =>
        Promise.resolve(
          Response.json(requestUrl(input).pathname === "/exec" ? result : { status: "ok" }),
        ),
      );
      vi.stubGlobal("fetch", fetcher);
      const createTool = vi.fn((backend: SandboxBackend) => metadataTool(backend, remote));
      const resolve = vi.fn(() =>
        Promise.resolve({ reveal: () => "synthetic-runtime-sandbox-token-0001" }),
      );
      const runtime = await createRuntime(
        {
          run,
          ...(remote
            ? {
                sandbox: SandboxConfigSchema.parse({
                  runner: { url: "http://sandbox-runner:8080", token: "env:RUNNER" },
                }),
              }
            : {}),
        },
        {
          ...overrides(),
          model: model(),
          policy: allowAllPolicy,
          createTool,
          secretResolver: { resolve },
        },
      );
      try {
        expect(runtime.sandboxBackend).toBeInstanceOf(
          remote ? RemoteSandboxBackend : InProcessBackend,
        );
        expect(createTool).toHaveBeenCalledExactlyOnceWith(runtime.sandboxBackend);
        const execution = await runtime.run("probe");
        expect(execution.status).toBe("completed");
        expect(execution.events.find((event) => event.type === "tool_result")).toMatchObject({
          outcome: "ok",
          result: { exitCode: 0, bytes: remote ? canary.length : "scrubbed".length },
        });
        const events = [];
        for await (const event of runtime.store.read(Id.parse(execution.events[0]?.runId))) {
          events.push(event);
        }
        expect(JSON.stringify(events)).not.toContain(canary);
        expect(JSON.stringify(events)).not.toContain("synthetic-runtime-sandbox-token-0001");
        expect(fetcher).toHaveBeenCalledTimes(remote ? 1 : 0);
        expect(resolve).toHaveBeenCalledTimes(remote ? 1 : 0);
      } finally {
        await runtime.close();
      }
    },
  );

  // threat: T-08
  it.each(["deny", "ask"] as const)(
    "does not execute the backend before policy %s",
    async (decision) => {
      const exec = vi.fn();
      const backend = { exec };
      const runtime = await createRuntime(
        { run },
        {
          ...overrides(),
          sandboxBackend: backend,
          createTool: (sandbox) => metadataTool(sandbox, false),
          model: model(),
          policy: {
            ...allowAllPolicy,
            decide: () => ({
              decision,
              ruleId: "sandbox_rule",
              reason: "sandbox_policy",
              editable: [],
            }),
          },
        },
      );
      try {
        await runtime.run("probe");
        expect(exec).not.toHaveBeenCalled();
      } finally {
        await runtime.close();
      }
    },
  );

  it("keeps an explicit tool override ahead of the tool factory", async () => {
    const createTool = vi.fn();
    const runtime = await createRuntime(
      { run },
      {
        ...overrides(),
        sandboxBackend: { exec: vi.fn() },
        tool: metadataTool({ exec: vi.fn() }, false),
        createTool,
      },
    );
    await runtime.close();
    expect(createTool).not.toHaveBeenCalled();
  });

  it.each(["none", "flush", "backend"] as const)(
    "closes the backend and storage even when %s fails during shutdown",
    async (failure) => {
      const error = new Error("synthetic");
      const close = vi.fn(() =>
        failure === "backend" ? Promise.reject(error) : Promise.resolve(),
      );
      const deps = overrides();
      const storeClose = vi.spyOn(deps.store, "close");
      const runtime = await createRuntime(
        { run },
        {
          ...deps,
          sandboxBackend: { exec: vi.fn(), close },
          flushTelemetry: () => (failure === "flush" ? Promise.reject(error) : Promise.resolve()),
        },
      );
      const thrown: unknown = await runtime.close().catch((caught: unknown) => caught);
      expect(thrown).toBe(failure === "none" ? undefined : error);
      expect(close).toHaveBeenCalledOnce();
      expect(storeClose).toHaveBeenCalledOnce();
    },
  );

  it("closes the backend if subsequent tool composition fails", async () => {
    const close = vi.fn(() => Promise.resolve());
    await expect(
      createRuntime(
        { run },
        {
          ...overrides(),
          sandboxBackend: { exec: vi.fn(), close },
          createTool: () => {
            throw new Error("synthetic");
          },
        },
      ),
    ).rejects.toThrow("synthetic");
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes a backend override if key resolution fails before tool composition", async () => {
    const close = vi.fn(() => Promise.resolve());
    await expect(
      createRuntime(
        {
          run,
          keys: {
            currentKeyId: "synthetic",
            keys: [{ id: "synthetic", secret: SecretRefSchema.parse("env:MISSING_KEY") }],
          },
        },
        {
          ...overrides(),
          sandboxBackend: { exec: vi.fn(), close },
          secretResolver: { resolve: () => Promise.reject(new Error("synthetic")) },
        },
      ),
    ).rejects.toBeDefined();
    expect(close).toHaveBeenCalledOnce();
  });
});
