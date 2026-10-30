// SPDX-License-Identifier: Apache-2.0
import { Id } from "@rovinos/schemas";
import type { ExecResult, ExecSpec, SandboxBackend } from "@rovinos/sandbox";
import { describe, expect, it, vi } from "vitest";
import type { GradeContext } from "./types.js";
import { createTestCommandGrader } from "./test-command.js";

const runId = Id.parse("00000000000000000000000001");

function context(backend: SandboxBackend): GradeContext {
  return {
    result: {
      status: "completed",
      runId,
      dbPath: "/synthetic/run.db",
      workspaceDir: "/synthetic/workspace",
      durationMs: 0,
      usage: { inputTokens: 0, outputTokens: 0, costMicros: 0 },
    },
    backend,
  };
}

function processResult(exitCode: number | null, timedOut = false): ExecResult {
  return {
    exitCode,
    stdout: "synthetic-command-output-canary",
    stderr: "",
    stdoutBytes: 32,
    stderrBytes: 0,
    truncated: false,
    timedOut,
    durationMs: 1,
  };
}

describe("createTestCommandGrader", () => {
  it("runs argv with the bounded default timeout and grades the exit code", async () => {
    let received: ExecSpec | undefined;
    const backend: SandboxBackend = {
      exec: vi.fn<SandboxBackend["exec"]>((_id, spec) => {
        received = spec;
        return Promise.resolve(processResult(0));
      }),
    };

    const result = await createTestCommandGrader({
      type: "test_command",
      argv: ["node", "--version"],
    }).grade(context(backend));

    expect(result).toMatchObject({ pass: true, score: 1, codes: [] });
    expect(received).toMatchObject({
      argv: ["node", "--version"],
      timeoutMs: 60_000,
      limits: { outputBytes: 65_536 },
    });
  });

  it("reports exit failures and timeouts without process output", async () => {
    const backend: SandboxBackend = {
      exec: vi
        .fn<SandboxBackend["exec"]>()
        .mockResolvedValueOnce(processResult(3))
        .mockResolvedValueOnce(processResult(null, true)),
    };

    const failed = await createTestCommandGrader({
      type: "test_command",
      argv: ["test"],
      expectExit: 2,
    }).grade(context(backend));
    const timedOut = await createTestCommandGrader({
      type: "test_command",
      argv: ["test"],
    }).grade(context(backend));

    expect(failed).toMatchObject({ pass: false, score: 0, codes: ["exit_nonzero"] });
    expect(timedOut).toMatchObject({ pass: false, score: 0, codes: ["timeout"] });
    expect(JSON.stringify([failed, timedOut])).not.toContain("synthetic-command-output-canary");
  });
});
