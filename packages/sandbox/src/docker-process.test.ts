// SPDX-License-Identifier: Apache-2.0
import { ChildProcess } from "node:child_process";
import type * as ChildProcessModule from "node:child_process";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DockerProcessOptions } from "./docker-process.js";
import { DockerProcessError, isDockerAvailable, runDockerProcess } from "./docker-process.js";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), spawnSync: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcessModule>();
  return { ...actual, spawn: mocks.spawn, spawnSync: mocks.spawnSync };
});

function makeChild() {
  const child = new ChildProcess();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.defineProperty(child, "stdin", { configurable: true, value: stdin });
  Object.defineProperty(child, "stdout", { configurable: true, value: stdout });
  Object.defineProperty(child, "stderr", { configurable: true, value: stderr });
  const kill = vi.spyOn(child, "kill").mockImplementation(() => {
    child.emit("close", null, "SIGTERM");
    return true;
  });
  return { child, stdin, stdout, stderr, kill };
}

function options(overrides: Partial<DockerProcessOptions> = {}): DockerProcessOptions {
  return {
    dockerPath: "docker",
    args: ["run", "--network", "none", "harness:test"],
    input: '{"goal":"synthetic"}',
    timeoutMs: 1_000,
    containerName: "harness-eval-synthetic",
    env: { HARNESS_EVAL_KEY: "synthetic-key" },
    ...overrides,
  };
}

afterEach(() => {
  mocks.spawn.mockReset();
  mocks.spawnSync.mockReset();
  vi.useRealTimers();
});

describe("runDockerProcess", () => {
  it("checks Docker availability with an argv-only probe", () => {
    mocks.spawnSync.mockReturnValue({ status: 0 });
    expect(isDockerAvailable()).toBe(true);
    expect(mocks.spawnSync).toHaveBeenCalledWith(
      "docker",
      ["info"],
      expect.objectContaining({ shell: false, stdio: "ignore", timeout: 5_000 }),
    );

    mocks.spawnSync.mockReturnValue({ status: 1 });
    expect(isDockerAvailable()).toBe(false);
    mocks.spawnSync.mockImplementation(() => {
      throw new Error("synthetic docker unavailable");
    });
    expect(isDockerAvailable()).toBe(false);
  });

  // threat: T-03
  it("runs argv without a shell and returns the process result", async () => {
    const child = makeChild();
    const calls: { args: string[]; options: { shell?: boolean; env?: NodeJS.ProcessEnv } }[] = [];
    let input = "";
    child.stdin.on("data", (chunk: Buffer) => {
      input += chunk.toString("utf8");
    });
    child.stdout.write("container stdout");
    child.stderr.write("container stderr");
    mocks.spawn.mockImplementation(
      (
        _command: string,
        args: string[],
        spawnOptions: { shell?: boolean; env?: NodeJS.ProcessEnv },
      ) => {
        calls.push({ args, options: spawnOptions });
        setImmediate(() => child.child.emit("close", 0, null));
        return child.child;
      },
    );

    await expect(runDockerProcess(options())).resolves.toEqual({
      exitCode: 0,
      timedOut: false,
      stdout: "container stdout",
      stderr: "container stderr",
    });

    expect(calls[0]?.args).toEqual(options().args);
    expect(calls[0]?.options).toMatchObject({
      shell: false,
      env: { HARNESS_EVAL_KEY: "synthetic-key" },
    });
    expect(JSON.stringify(calls[0]?.args)).not.toContain("synthetic-key");
    expect(input).toBe(options().input);
  });

  it("maps process launch and asynchronous errors to a closed error code", async () => {
    mocks.spawn.mockImplementationOnce(() => {
      throw new Error("synthetic private path");
    });
    await expect(runDockerProcess(options())).rejects.toBeInstanceOf(DockerProcessError);

    const child = makeChild();
    mocks.spawn.mockImplementationOnce(() => {
      setImmediate(() => child.child.emit("error", new Error("synthetic private path")));
      return child.child;
    });
    await expect(runDockerProcess(options())).rejects.toMatchObject({
      code: "docker_process_failed",
    });
  });

  // threat: T-10
  it("kills the named container and local process after a timeout", async () => {
    const main = makeChild();
    const killer = makeChild();
    mocks.spawn.mockImplementation((_command: string, args: string[]) => {
      if (args[0] === "kill") {
        setImmediate(() => killer.child.emit("close", 0, null));
        return killer.child;
      }
      return main.child;
    });

    await expect(runDockerProcess(options({ timeoutMs: 5 }))).resolves.toMatchObject({
      exitCode: null,
      timedOut: true,
    });

    expect(mocks.spawn).toHaveBeenNthCalledWith(
      2,
      "docker",
      ["kill", "harness-eval-synthetic"],
      expect.objectContaining({ shell: false, stdio: "ignore" }),
    );
    expect(main.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("still terminates the local process if Docker kill cannot start", async () => {
    const main = makeChild();
    mocks.spawn
      .mockImplementationOnce(() => main.child)
      .mockImplementationOnce(() => {
        throw new Error("synthetic docker unavailable");
      });

    await expect(runDockerProcess(options({ timeoutMs: 5 }))).resolves.toMatchObject({
      timedOut: true,
    });

    expect(main.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
