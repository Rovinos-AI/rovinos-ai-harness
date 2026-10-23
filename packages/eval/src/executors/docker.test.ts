// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock, parseJson, SequentialIdGenerator } from "@harness/schemas";
import type { ModelPort } from "@harness/core";
import { createRuntime } from "@harness/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineSuite } from "../load.js";
import { TrialConfigSchema } from "../executor.js";
import type { TrialSpec } from "../trial.js";

const mocks = vi.hoisted(() => ({ execa: vi.fn() }));

vi.mock("execa", () => ({ execa: mocks.execa }));

import { DockerExecutor } from "./docker.js";

const directories: string[] = [];

function completedProcess(exitCode: number): Promise<{ exitCode: number }> & {
  kill: ReturnType<typeof vi.fn>;
} {
  return Object.assign(Promise.resolve({ exitCode }), { kill: vi.fn(() => true) });
}

function pendingProcess(): Promise<{ exitCode: number }> & { kill: ReturnType<typeof vi.fn> } {
  let finish: (result: { exitCode: number }) => void = () => undefined;
  const promise = new Promise<{ exitCode: number }>((resolve) => {
    finish = resolve;
  });
  return Object.assign(promise, {
    kill: vi.fn(() => {
      finish({ exitCode: 143 });
      return true;
    }),
  });
}

async function createDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "harness-eval-docker-"));
  directories.push(path);
  return path;
}

function makeTrial(workDir: string): TrialSpec {
  const suite = defineSuite({
    schemaVersion: 1,
    tasks: [{ id: "docker_task", input: { goal: "A synthetic goal." }, graders: [], tags: [] }],
  });
  const task = suite.tasks[0];
  if (task === undefined) {
    throw new Error("docker_task_missing");
  }
  const variant = { id: "baseline" };
  return {
    suite,
    task,
    variantId: variant.id,
    variant,
    trialIndex: 0,
    seed: 7,
    workDir,
  };
}

function model(): ModelPort {
  return {
    complete: () =>
      Promise.resolve({
        provider: "synthetic",
        model: "synthetic",
        parts: [{ type: "text", text: "done" }],
        providerBlobs: null,
        usage: { inputTokens: 3, outputTokens: 2 },
        finishReason: "stop",
        latencyMs: 0,
        schemaValid: true,
        repairAttempts: 0,
        fallbackDepth: 0,
      }),
  };
}

async function createRun(workDir: string, key: string, run: boolean): Promise<void> {
  const config = parseJson(
    TrialConfigSchema,
    await readFile(join(workDir, "harness.config.json"), "utf8"),
  );
  const runtime = await createRuntime(
    {
      run: config.run,
      roles: config.roles,
      store: config.store,
      keys: config.keys,
      models: config.models,
      policy: config.policy,
      pii: config.pii,
      vault: config.vault,
    },
    {
      dataDir: join(workDir, "data"),
      transientVault: false,
      clock: new FakeClock(1_700_000_000_000),
      ids: new SequentialIdGenerator(),
      model: model(),
      secretResolver: { resolve: () => Promise.resolve({ reveal: () => key }) },
    },
  );
  try {
    if (run) {
      await runtime.run({ goal: "A synthetic goal." });
    }
  } finally {
    await runtime.close();
  }
}

afterEach(async () => {
  mocks.execa.mockReset();
  vi.useRealTimers();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("DockerExecutor", () => {
  it("uses the isolated database to collect run status and usage", async () => {
    const root = await createDirectory();
    const workDir = join(root, "trial");
    let invocation: { args: string[]; input: string | undefined } | undefined;
    mocks.execa.mockImplementation(
      (_command: string, args: string[], options: { env?: NodeJS.ProcessEnv; input?: string }) => {
        invocation = { args, input: options.input };
        const key = options.env?.HARNESS_EVAL_KEY;
        if (key === undefined) {
          throw new Error("synthetic_key_missing");
        }
        return createRun(workDir, key, true).then(() => ({ exitCode: 0 }));
      },
    );

    const result = await new DockerExecutor({ image: "synthetic/harness" }).run(makeTrial(workDir));

    expect(result.status).toBe("completed");
    expect(result.runId).toBeDefined();
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 2, costMicros: 0 });
    expect(result.exitCode).toBe(0);
    expect(invocation?.args).toEqual(expect.arrayContaining(["--network", "none", "--input", "-"]));
    expect(invocation?.input).toBe(JSON.stringify({ goal: "A synthetic goal." }));
    expect(JSON.stringify(invocation?.args)).not.toContain("A synthetic goal.");
  });

  it("returns a safe error when Docker exits without creating a run", async () => {
    const workDir = join(await createDirectory(), "trial");
    mocks.execa.mockImplementation(() => completedProcess(17));

    const result = await new DockerExecutor({ image: "synthetic/harness" }).run(makeTrial(workDir));

    expect(result).toMatchObject({
      status: "error",
      errorCode: "docker_exit_nonzero",
      exitCode: 17,
      usage: { inputTokens: 0, outputTokens: 0, costMicros: 0 },
    });
  });

  it("enforces the wall-clock timeout and kills the named container", async () => {
    const workDir = join(await createDirectory(), "trial");
    let processInvocation = 0;
    let killArgs: string[] | undefined;
    mocks.execa.mockImplementation((_command: string, args: string[]) => {
      if (args[0] === "kill") {
        killArgs = args;
        return completedProcess(0);
      }
      processInvocation += 1;
      return pendingProcess();
    });

    const pending = new DockerExecutor({
      image: "synthetic/harness",
      timeoutMs: 5,
    }).run(makeTrial(workDir));
    const result = await pending;

    expect(result).toMatchObject({ status: "error", errorCode: "trial_timeout" });
    expect(processInvocation).toBe(1);
    expect(killArgs).toEqual(["kill", expect.stringMatching(/^harness-eval-/u)]);
  });

  it("turns process failures into stable errors without leaking details", async () => {
    const workDir = join(await createDirectory(), "trial");
    mocks.execa.mockImplementationOnce(() => Promise.reject(new Error("synthetic private path")));
    await expect(
      new DockerExecutor({ image: "synthetic/harness" }).run(makeTrial(workDir)),
    ).rejects.toMatchObject({ code: "docker_process_failed" });

    const secondWorkDir = join(await createDirectory(), "trial");
    mocks.execa.mockImplementationOnce(() => Promise.reject(new Error("synthetic private path")));
    await expect(
      new DockerExecutor({ image: "synthetic/harness" }).run(makeTrial(secondWorkDir)),
    ).rejects.toMatchObject({ code: "docker_process_failed" });
  });
});
