// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Id } from "@harness/schemas";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeSpec } from "./exec.js";
import type { ExecSpec } from "../../src/types.js";

const runId = Id.parse("00000000000000000000000001");
const limits = { memoryMb: 2048, pids: 2048, outputBytes: 1024, cpuSeconds: 5 };
let workspaceRoot: string;

function makeSpec(
  argv: string[],
  options: Partial<Pick<ExecSpec, "cwd" | "env" | "stdin" | "timeoutMs" | "limits">> = {},
): ExecSpec {
  return { argv, timeoutMs: 2000, limits, ...options };
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

    const result = await executeSpec(
      runId,
      { ...spec, stdin: "hello" },
      new AbortController().signal,
      workspaceRoot,
    );

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
    const result = await executeSpec(
      runId,
      makeSpec([process.execPath, "-e", 'process.stdout.write("abcdefgh")'], {
        limits: { ...limits, outputBytes: 4 },
      }),
      new AbortController().signal,
      workspaceRoot,
    );

    expect(result).toMatchObject({
      stdout: "abcd",
      stdoutBytes: 8,
      stderrBytes: 0,
      truncated: true,
    });
  });

  it("kills the process group when the command exceeds its timeout", async () => {
    const result = await executeSpec(
      runId,
      makeSpec([process.execPath, "-e", "setInterval(() => {}, 1000)"], { timeoutMs: 100 }),
      new AbortController().signal,
      workspaceRoot,
    );

    expect(result).toMatchObject({ timedOut: true, signal: "SIGKILL" });
  });

  it("returns a cancelled result without spawning when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      executeSpec(
        runId,
        makeSpec([process.execPath, "-e", "process.exit(1)"]),
        controller.signal,
        workspaceRoot,
      ),
    ).resolves.toMatchObject({ exitCode: null, signal: "SIGKILL", timedOut: false });
  });

  it("rejects working directories outside the workspace", async () => {
    await expect(
      executeSpec(
        runId,
        makeSpec([process.execPath, "-e", "process.exit(0)"], { cwd: "../" }),
        new AbortController().signal,
        workspaceRoot,
      ),
    ).rejects.toMatchObject({ code: "sandbox_workspace_path_invalid" });
  });
});
