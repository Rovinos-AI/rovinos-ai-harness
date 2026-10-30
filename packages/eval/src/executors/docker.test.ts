// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock, parseJson, SequentialIdGenerator } from "@rovinos/schemas";
import type { ModelPort } from "@rovinos/core";
import { createRuntime } from "@rovinos/core";
import type * as SandboxModule from "@rovinos/sandbox";
import type { DockerProcessOptions, DockerProcessResult } from "@rovinos/sandbox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineSuite } from "../load.js";
import { TrialConfigSchema } from "../executor.js";
import { evalSuiteCode } from "../trial.js";
import type { TrialSpec } from "../trial.js";

const mocks = vi.hoisted(() => ({ runDockerProcess: vi.fn() }));

vi.mock("@rovinos/sandbox", async (importOriginal) => {
  const actual = await importOriginal<typeof SandboxModule>();
  return { ...actual, runDockerProcess: mocks.runDockerProcess };
});

import { DockerExecutor } from "./docker.js";

const directories: string[] = [];

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
  mocks.runDockerProcess.mockReset();
  vi.useRealTimers();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("DockerExecutor", () => {
  it("uses the isolated database to collect run status and usage", async () => {
    const root = await createDirectory();
    const workDir = join(root, "trial");
    const trial = makeTrial(workDir);
    let invocation: DockerProcessOptions | undefined;
    let now = 0;
    mocks.runDockerProcess.mockImplementation(async (options: DockerProcessOptions) => {
      invocation = options;
      const key = options.env.HARNESS_EVAL_KEY;
      if (key === undefined) {
        throw new Error("synthetic_key_missing");
      }
      await createRun(workDir, key, true);
      return { exitCode: 0, timedOut: false } satisfies DockerProcessResult;
    });

    const result = await new DockerExecutor(
      { image: "synthetic/harness" },
      {
        clock: { now: () => (now += 10) },
        randomBytes: (size) => new Uint8Array(size).fill(9),
      },
    ).run(trial);

    expect(result.status).toBe("completed");
    expect(result.runId).toBeDefined();
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 2, costMicros: 0 });
    expect(result.exitCode).toBe(0);
    expect(result.durationMs).toBeGreaterThan(0);
    expect(invocation?.env.HARNESS_EVAL_KEY).toBe(Buffer.alloc(32, 9).toString("base64"));
    expect(invocation?.args).toContain(
      `HARNESS_EVAL_METADATA=${JSON.stringify({
        suite: evalSuiteCode(trial.suite),
        task: trial.task.id,
        trial: trial.trialIndex,
      })}`,
    );
    // threat: T-02, T-07, T-08, T-16
    expect(invocation?.args).toEqual(
      expect.arrayContaining([
        "--network",
        "none",
        "--input",
        "-",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        "--read-only",
        "--tmpfs",
        "/tmp:size=64m,noexec,nosuid,nodev",
        "--user",
        "65532:65532",
        "--memory",
        "1g",
        "--cpus",
        "1",
        "--pids-limit",
        "256",
      ]),
    );
    expect(invocation?.input).toBe(JSON.stringify({ goal: "A synthetic goal." }));
    expect(JSON.stringify(invocation?.args)).not.toContain("A synthetic goal.");
  });

  it("returns a safe error when Docker exits without creating a run", async () => {
    const workDir = join(await createDirectory(), "trial");
    mocks.runDockerProcess.mockResolvedValue({ exitCode: 17, timedOut: false });

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
    let containerName: string | undefined;
    mocks.runDockerProcess.mockImplementation((options: DockerProcessOptions) => {
      containerName = options.containerName;
      return Promise.resolve({ exitCode: null, timedOut: true });
    });

    const pending = new DockerExecutor({
      image: "synthetic/harness",
      timeoutMs: 5,
    }).run(makeTrial(workDir));
    const result = await pending;

    expect(result).toMatchObject({ status: "error", errorCode: "trial_timeout" });
    expect(containerName).toMatch(/^harness-eval-/u);
  });

  it("accepts bounded resource overrides while requiring a non-root user", async () => {
    const workDir = join(await createDirectory(), "trial");
    let args: string[] = [];
    mocks.runDockerProcess.mockImplementation((options: DockerProcessOptions) => {
      args = [...options.args];
      return Promise.resolve({ exitCode: 1, timedOut: false });
    });

    await new DockerExecutor({
      image: "synthetic/harness",
      memory: "512m",
      cpus: 2,
      pidsLimit: 64,
      tmpfsSize: "128m",
      user: "1001:1001",
    }).run(makeTrial(workDir));

    expect(args).toEqual(
      expect.arrayContaining([
        "/tmp:size=128m,noexec,nosuid,nodev",
        "--user",
        "1001:1001",
        "--memory",
        "512m",
        "--cpus",
        "2",
        "--pids-limit",
        "64",
      ]),
    );
    expect(() => new DockerExecutor({ image: "synthetic/harness", user: "0:0" })).toThrow();
  });

  it("returns typed process errors without leaking details", async () => {
    const workDir = join(await createDirectory(), "trial");
    mocks.runDockerProcess.mockRejectedValueOnce(new Error("synthetic private path"));
    await expect(
      new DockerExecutor({ image: "synthetic/harness" }).run(makeTrial(workDir)),
    ).rejects.toMatchObject({ code: "docker_process_failed" });

    const secondWorkDir = join(await createDirectory(), "trial");
    mocks.runDockerProcess.mockRejectedValueOnce(new Error("synthetic private path"));
    await expect(
      new DockerExecutor({ image: "synthetic/harness" }).run(makeTrial(secondWorkDir)),
    ).rejects.toMatchObject({ code: "docker_process_failed" });
  });

  it("rejects mount paths with commas using a typed error", async () => {
    const workDir = join(await createDirectory(), "trial,invalid");
    await expect(
      new DockerExecutor({ image: "synthetic/harness" }).run(makeTrial(workDir)),
    ).rejects.toMatchObject({ code: "docker_mount_path_invalid" });
  });
});
