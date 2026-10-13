// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeSpec } from "./exec.js";
import type { ExecSpec } from "../../src/types.js";

const limits = { memoryMb: 2048, pids: 2048, outputBytes: 1024, cpuSeconds: 5 };
const executionUid = process.getuid?.() ?? 10003;
const executionGid = process.getgid?.() ?? 10003;
let workspaceRoot: string;

function makeSpec(
  argv: string[],
  options: Partial<Pick<ExecSpec, "cwd" | "env" | "stdin" | "timeoutMs" | "limits">> = {},
): ExecSpec {
  return { argv, timeoutMs: 2000, limits, ...options };
}

function execute(spec: ExecSpec, signal = new AbortController().signal) {
  return executeSpec({
    spec,
    signal,
    workspaceRoot,
    executionUid,
    executionGid,
  });
}

describe("executeSpec", () => {
  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "sandbox-runner-exec-"));
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it("runs argv without a shell, passes stdin, and captures both output streams", async () => {
    const spec = makeSpec([
      process.execPath,
      "-e",
      'process.stdin.pipe(process.stdout); process.stderr.write("diagnostic")',
    ]);

    const result = await execute({ ...spec, stdin: "hello" });

    expect(result).toMatchObject({
      exitCode: 0,
      stdout: "hello",
      stderr: "diagnostic",
      stdoutBytes: 5,
      stderrBytes: 10,
      timedOut: false,
    });
  });

  it("bounds captured output and preserves the total byte counts", async () => {
    const result = await execute(
      makeSpec([process.execPath, "-e", 'process.stdout.write("abcdefgh")'], {
        limits: { ...limits, outputBytes: 4 },
      }),
    );

    expect(result).toMatchObject({
      stdout: "abcd",
      stdoutBytes: 8,
      stderrBytes: 0,
      truncated: true,
    });
  });

  it("kills the process group when the command exceeds its timeout", async () => {
    const result = await execute(
      makeSpec([process.execPath, "-e", "setInterval(() => {}, 1000)"], { timeoutMs: 100 }),
    );

    expect(result).toMatchObject({ timedOut: true, signal: "SIGKILL" });
  });

  it("returns a cancelled result without spawning when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      execute(makeSpec([process.execPath, "-e", "process.exit(1)"]), controller.signal),
    ).resolves.toMatchObject({ exitCode: null, signal: "SIGKILL", timedOut: false });
  });

  it("rejects working directories outside the workspace", async () => {
    await expect(
      execute(makeSpec([process.execPath, "-e", "process.exit(0)"], { cwd: "../" })),
    ).rejects.toMatchObject({ code: "sandbox_workspace_path_invalid" });
  });

  it("returns a safe error when the command credentials are invalid", async () => {
    await expect(
      executeSpec({
        spec: makeSpec([process.execPath, "-e", "process.exit(0)"]),
        signal: new AbortController().signal,
        workspaceRoot,
        executionUid: -1,
        executionGid: -1,
      }),
    ).rejects.toMatchObject({ code: "sandbox_exec_failed" });
  });

  it("decodes stdout and stderr independently", async () => {
    const result = await execute(
      makeSpec([
        process.execPath,
        "-e",
        'process.stdout.write(Buffer.from([0xe2])); process.stderr.write("ok")',
      ]),
    );

    expect(result.stdout).toBe("\uFFFD");
    expect(result.stderr).toBe("ok");
  });
});
