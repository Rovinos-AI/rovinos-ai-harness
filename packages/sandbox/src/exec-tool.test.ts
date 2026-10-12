// SPDX-License-Identifier: Apache-2.0
import { Id, JsonValue } from "@harness/schemas";
import { describe, expect, it, vi } from "vitest";
import { ExecToolInputSchema, SandboxExecTool } from "./index.js";
import type { ExecResult, SandboxBackend } from "./index.js";

const runId = Id.parse("00000000000000000000000002");
const callId = Id.parse("00000000000000000000000003");
const result: ExecResult = {
  exitCode: 0,
  stdout: "done",
  stderr: "",
  stdoutBytes: 4,
  stderrBytes: 0,
  truncated: false,
  timedOut: false,
  durationMs: 2,
};

function makeCall(toolId: string, args: unknown) {
  return { callId, toolId, args: JsonValue.parse(args) };
}

describe("SandboxExecTool", () => {
  it("advertises the subset schema and describes execution as non-idempotent", () => {
    const backend = { exec: vi.fn() } satisfies Pick<SandboxBackend, "exec">;
    const tool = new SandboxExecTool({
      backend,
      limits: { memoryMb: 128, pids: 16, outputBytes: 1024, cpuSeconds: 5 },
    });

    expect(tool.getToolSpecs()[0]?.toolId).toBe("sandbox.exec");
    expect(ExecToolInputSchema.safeParse({ argv: ["echo"], timeoutMs: 1000 }).success).toBe(true);
    expect(
      ExecToolInputSchema.safeParse({
        argv: ["echo"],
        timeoutMs: 1000,
        limits: { memoryMb: 128, pids: 16, outputBytes: 1024, cpuSeconds: 5 },
      }).success,
    ).toBe(false);
    expect(tool.describe("sandbox.exec")).toEqual({ idempotent: false, timeoutMs: 300_000 });
    expect(tool.describe("other.tool")).toBeUndefined();
  });

  it("executes validated calls with host-controlled limits and returns the standard output shape", async () => {
    const backend = { exec: vi.fn().mockResolvedValue(result) } satisfies Pick<
      SandboxBackend,
      "exec"
    >;
    const limits = { memoryMb: 128, pids: 16, outputBytes: 1024, cpuSeconds: 5 };
    const tool = new SandboxExecTool({ backend, limits });

    const response = await tool.execute(
      makeCall("sandbox.exec", { argv: ["echo"], timeoutMs: 1000 }),
      { runId, signal: new AbortController().signal },
    );

    expect(response).toEqual({
      outcome: "ok",
      result: {
        exitCode: 0,
        stdout: "done",
        stderr: "",
        truncated: false,
        timedOut: false,
      },
    });
    expect(backend.exec).toHaveBeenCalledWith(
      runId,
      { argv: ["echo"], timeoutMs: 1000, limits },
      expect.any(AbortSignal),
    );
  });

  it("returns closed errors for unknown tools, invalid arguments, and backend failure", async () => {
    const backend = {
      exec: vi.fn().mockRejectedValue(new Error("private failure")),
    } satisfies Pick<SandboxBackend, "exec">;
    const tool = new SandboxExecTool({
      backend,
      limits: { memoryMb: 128, pids: 16, outputBytes: 1024, cpuSeconds: 5 },
    });
    const context = { runId, signal: new AbortController().signal };

    await expect(tool.execute(makeCall("other.tool", {}), context)).resolves.toMatchObject({
      outcome: "error",
      errorCode: "sandbox_exec_unknown_tool",
    });
    await expect(tool.execute(makeCall("sandbox.exec", {}), context)).resolves.toMatchObject({
      outcome: "error",
      errorCode: "sandbox_exec_invalid",
    });
    await expect(
      tool.execute(
        makeCall("sandbox.exec", {
          argv: ["echo"],
          timeoutMs: 1000,
          env: { NODE_OPTIONS: "--require=./workspace.js" },
        }),
        context,
      ),
    ).resolves.toMatchObject({
      outcome: "error",
      errorCode: "sandbox_env_forbidden",
    });
    await expect(
      tool.execute(makeCall("sandbox.exec", { argv: ["echo"], timeoutMs: 1000 }), context),
    ).resolves.toMatchObject({
      outcome: "error",
      errorCode: "sandbox_exec_failed",
    });
  });
});
