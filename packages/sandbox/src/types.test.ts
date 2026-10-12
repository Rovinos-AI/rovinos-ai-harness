// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  ExecLimitsSchema,
  ExecResultSchema,
  ExecSpecSchema,
  MAX_EXEC_TIMEOUT_MS,
  SANDBOX_ENV_FORBIDDEN_CODE,
} from "./index.js";

const limits = { memoryMb: 128, pids: 16, outputBytes: 1024, cpuSeconds: 5 };

describe("sandbox execution contracts", () => {
  it("accepts shell-free commands with optional stdin and bounded safe env keys", () => {
    expect(
      ExecSpecSchema.parse({
        argv: ["/bin/echo", "hello"],
        timeoutMs: 1000,
        limits,
        env: { APP_MODE: "test" },
      }),
    ).toMatchObject({ argv: ["/bin/echo", "hello"], env: { APP_MODE: "test" } });
  });

  it("rejects empty executable names, oversized argv lists, invalid env keys, and oversized stdin", () => {
    expect(ExecSpecSchema.safeParse({ argv: [""], timeoutMs: 1000, limits }).success).toBe(false);
    expect(
      ExecSpecSchema.safeParse({
        argv: Array.from({ length: 65 }, () => "arg"),
        timeoutMs: 1000,
        limits,
      }).success,
    ).toBe(false);
    expect(
      ExecSpecSchema.safeParse({
        argv: ["echo"],
        timeoutMs: 1000,
        limits,
        env: { lowercase: "value" },
      }).success,
    ).toBe(false);
    expect(
      ExecSpecSchema.safeParse({
        argv: ["cat"],
        timeoutMs: 1000,
        limits,
        stdin: "é".repeat(524_289),
      }).success,
    ).toBe(false);
  });

  it("limits environment entries to 32 and enforces positive resource limits", () => {
    const environment = Object.fromEntries(
      Array.from({ length: 33 }, (_, index) => [`VAR_${String(index)}`, "value"]),
    );
    expect(
      ExecSpecSchema.safeParse({
        argv: ["echo"],
        timeoutMs: 1000,
        limits,
        env: environment,
      }).success,
    ).toBe(false);
    expect(ExecLimitsSchema.safeParse({ ...limits, pids: 0 }).success).toBe(false);
  });

  it("rejects loader and interpreter startup environment variables with a closed code", () => {
    for (const key of [
      "PATH",
      "LD_PRELOAD",
      "LD_LIBRARY_PATH",
      "DYLD_INSERT_LIBRARIES",
      "NODE_OPTIONS",
      "PYTHONSTARTUP",
      "PERL5OPT",
      "BASH_ENV",
      "_JAVA_OPTIONS",
    ]) {
      const result = ExecSpecSchema.safeParse({
        argv: ["echo"],
        timeoutMs: 1000,
        limits,
        env: { [key]: "synthetic" },
      });

      expect(result.success).toBe(false);
      const issues = result.success ? [] : result.error.issues;
      expect(issues.some((issue) => issue.message === SANDBOX_ENV_FORBIDDEN_CODE)).toBe(true);
    }
  });

  it("caps timeouts at the built-in tool's advertised maximum", () => {
    const base = { argv: ["echo"], limits };

    expect(ExecSpecSchema.safeParse({ ...base, timeoutMs: MAX_EXEC_TIMEOUT_MS }).success).toBe(
      true,
    );
    expect(ExecSpecSchema.safeParse({ ...base, timeoutMs: MAX_EXEC_TIMEOUT_MS + 1 }).success).toBe(
      false,
    );
  });

  it("validates result metadata", () => {
    expect(
      ExecResultSchema.parse({
        exitCode: null,
        signal: "SIGKILL",
        stdout: "",
        stderr: "",
        stdoutBytes: 0,
        stderrBytes: 0,
        truncated: false,
        timedOut: true,
        durationMs: 10,
      }).timedOut,
    ).toBe(true);
    expect(
      ExecResultSchema.safeParse({
        exitCode: -1,
        stdout: "",
        stderr: "",
        stdoutBytes: 0,
        stderrBytes: 0,
        truncated: false,
        timedOut: false,
        durationMs: 1,
      }).success,
    ).toBe(false);
  });
});
