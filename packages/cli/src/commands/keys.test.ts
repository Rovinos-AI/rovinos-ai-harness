// SPDX-License-Identifier: Apache-2.0
import { KeyGenerateResultSchema, parseJson } from "@harness/schemas";
import { describe, expect, it } from "vitest";
import type { CliContext } from "../command.js";
import { ExitCode } from "../exit-codes.js";
import { createOutput } from "../output.js";
import { main } from "../main.js";
import { keysCommand } from "./keys.js";

function createContext() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const context: CliContext = {
    loadConfig: () => Promise.reject(new Error("Configuration is not needed.")),
    out: createOutput({
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    }),
    clock: { now: () => 0 },
  };
  return { context, stdout, stderr };
}

describe("harness keys generate", () => {
  it("prints a fresh 32-byte base64 key and storage guidance", async () => {
    const { context, stdout, stderr } = createContext();

    const exitCode = await main(["keys", "generate"], context, [keysCommand]);
    const [key = ""] = stdout[0]?.split("\n") ?? [];

    expect(exitCode).toBe(ExitCode.ok);
    expect(Buffer.from(key, "base64")).toHaveLength(32);
    expect(Buffer.from(key, "base64").toString("base64")).toBe(key);
    expect(stdout.join("")).toContain("environment variable or a secret store");
    expect(stderr).toEqual([]);
  });

  it("emits the generated key as one validated JSON document when requested", async () => {
    const { context, stdout, stderr } = createContext();

    const exitCode = await main(["--json", "keys", "generate"], context, [keysCommand]);
    const result = parseJson(KeyGenerateResultSchema, stdout[0] ?? "");

    expect(exitCode).toBe(ExitCode.ok);
    expect(Buffer.from(result.key, "base64")).toHaveLength(32);
    expect(result.instructions).toContain("secret store");
    expect(stderr).toEqual([]);
  });

  it("mentions secret storage in command help", async () => {
    const { context, stdout } = createContext();

    const exitCode = await main(["keys", "generate", "--help"], context, [keysCommand]);

    expect(exitCode).toBe(ExitCode.ok);
    expect(stdout.join("")).toContain("environment variable or secret store");
  });
});
