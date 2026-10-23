// SPDX-License-Identifier: Apache-2.0
import { ChildProcess } from "node:child_process";
import type * as ChildProcessModule from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock, parseJson, SequentialIdGenerator } from "@harness/schemas";
import type { ModelPort } from "@harness/core";
import { createRuntime } from "@harness/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineSuite } from "../load.js";
import { TrialConfigSchema } from "../executor.js";
import type { TrialSpec } from "../trial.js";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcessModule>();
  return { ...actual, spawn: mocks.spawn };
});

import { DockerExecutor } from "./docker.js";

const directories: string[] = [];

function makeChild() {
  const child = new ChildProcess();
  const input = new PassThrough();
  Object.defineProperty(child, "stdin", { configurable: true, value: input });
  const kill = vi.spyOn(child, "kill").mockImplementation(() => {
    child.emit("close", null, "SIGTERM");
    return true;
  });
  return { child, input, kill };
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
  mocks.spawn.mockReset();
  vi.useRealTimers();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("DockerExecutor", () => {
  it("uses the isolated database to collect run status and usage", async () => {
    const root = await createDirectory();
    const workDir = join(root, "trial");
    const { child } = makeChild();
    mocks.spawn.mockImplementation((_command: string, args: string[]) => {
      const key = args.find((arg) => arg.startsWith("HARNESS_EVAL_KEY="))?.slice(
        "HARNESS_EVAL_KEY=".length,
      );
      if (key === undefined) {
        throw new Error("synthetic_key_missing");
      }
      setImmediate(() => {
        void createRun(workDir, key, true).then(
          () => child.emit("close", 0, null),
          () => child.emit("error", new Error("synthetic_container_failure")),
        );
      });
      return child;
    });

    const result = await new DockerExecutor({ image: "synthetic/harness" }).run(
      makeTrial(workDir),
    );

    expect(result.status).toBe("completed");
    expect(result.runId).toBeDefined();
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 2, costMicros: 0 });
    expect(result.exitCode).toBe(0);
    expect(mocks.spawn).toHaveBeenCalledWith(
      "docker",
      expect.arrayContaining(["--network", "none", "--input", "-", "HARNESS_EVAL_KEY"]),
      expect.objectContaining({
        env: expect.objectContaining({ HARNESS_EVAL_KEY: expect.any(String) }),
        stdio: ["pipe", "ignore", "ignore"],
      }),
    );
    expect(JSON.stringify(mocks.spawn.mock.calls[0])).not.toContain("A synthetic goal.");
  });

  it("returns a safe error when Docker exits without creating a run", async () => {
    const workDir = join(await createDirectory(), "trial");
    const { child } = makeChild();
    mocks.spawn.mockImplementation(() => {
      setImmediate(() => child.emit("close", 17, null));
      return child;
    });

    const result = await new DockerExecutor({ image: "synthetic/harness" }).run(
      makeTrial(workDir),
    );

    expect(result).toMatchObject({
      status: "error",
      errorCode: "docker_exit_nonzero",
      exitCode: 17,
      usage: { inputTokens: 0, outputTokens: 0, costMicros: 0 },
    });
  });

  it("enforces the wall-clock timeout and kills the named container", async () => {
    const workDir = join(await createDirectory(), "trial");
    const children = [makeChild(), makeChild()];
    mocks.spawn.mockImplementation(() => {
      const next = children.shift();
      if (next === undefined) {
        throw new Error("synthetic_spawn_unexpected");
      }
      return next.child;
    });

    const pending = new DockerExecutor({
      image: "synthetic/harness",
      timeoutMs: 5,
    }).run(makeTrial(workDir));
    const result = await pending;

    expect(result).toMatchObject({ status: "error", errorCode: "trial_timeout" });
    expect(mocks.spawn).toHaveBeenLastCalledWith(
      "docker",
      ["kill", expect.stringMatching(/^harness-eval-/u)],
      { stdio: "ignore" },
    );
  });

  it("turns process launch failures into stable errors without leaking details", async () => {
    const workDir = join(await createDirectory(), "trial");
    mocks.spawn.mockImplementationOnce(() => {
      throw new Error("synthetic private path");
    });
    await expect(
      new DockerExecutor({ image: "synthetic/harness" }).run(makeTrial(workDir)),
    ).rejects.toMatchObject({ code: "docker_spawn_failed" });

    const secondWorkDir = join(await createDirectory(), "trial");
    const { child } = makeChild();
    mocks.spawn.mockImplementationOnce(() => {
      setImmediate(() => child.emit("error", new Error("synthetic private path")));
      return child;
    });
    await expect(
      new DockerExecutor({ image: "synthetic/harness" }).run(makeTrial(secondWorkDir)),
    ).rejects.toMatchObject({ code: "docker_process_failed" });
  });
});
