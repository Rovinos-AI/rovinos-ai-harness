// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseJson, PolicyLintResultSchema, PolicyTestResultSchema } from "@harness/schemas";
import { afterEach, describe, expect, it } from "vitest";
import type { CliContext } from "../command.js";
import { ExitCode } from "../exit-codes.js";
import { main } from "../main.js";
import { createOutput } from "../output.js";
import { policyCommand } from "./policy.js";

const policyText = `version: 1
defaultDecision: deny
rules:
  - id: allow_read
    match:
      tools: [fs.read]
    decision: allow
    reason: read_only
`;
const callLine = JSON.stringify({
  id: "read_one",
  toolId: "fs.read",
  args: { path: "/workspace/file" },
});
const expectationLine = JSON.stringify({ id: "read_one", decision: "allow", ruleId: "allow_read" });
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createFixture(options: {
  readonly policy?: string;
  readonly calls?: string;
  readonly expectations?: string;
}) {
  const directory = await mkdtemp(join(tmpdir(), "harness-policy-cli-"));
  directories.push(directory);
  const policyPath = join(directory, "policy.yaml");
  const callsPath = join(directory, "calls.jsonl");
  const expectPath = join(directory, "expect.jsonl");
  await Promise.all([
    writeFile(policyPath, options.policy ?? policyText),
    writeFile(callsPath, options.calls ?? callLine),
    writeFile(expectPath, options.expectations ?? expectationLine),
  ]);
  const stdout: string[] = [];
  const stderr: string[] = [];
  let configLoads = 0;
  const context: CliContext = {
    loadConfig: async () => {
      configLoads += 1;
      throw new Error("Offline policy commands must not load configuration.");
    },
    out: createOutput({
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    }),
    clock: { now: () => 0 },
  };
  return {
    context,
    stdout,
    stderr,
    configLoads: () => configLoads,
    policyPath,
    callsPath,
    expectPath,
  };
}

describe("harness policy test", () => {
  it("evaluates fixture calls, checks expectations, and includes explanations on request", async () => {
    const fixture = await createFixture({});

    const exitCode = await main(
      [
        "policy",
        "test",
        "--policy",
        fixture.policyPath,
        "--calls",
        fixture.callsPath,
        "--expect",
        fixture.expectPath,
        "--explain",
      ],
      fixture.context,
      [policyCommand],
    );

    expect(exitCode, fixture.stderr.join("")).toBe(ExitCode.ok);
    expect(fixture.stdout.join("")).toContain("read_one\tallow\tallow_read\tread_only\tallow_read");
    expect(fixture.stderr).toEqual([]);
    expect(fixture.configLoads()).toBe(0);
  });

  it("emits exactly one validated JSON report", async () => {
    const fixture = await createFixture({});

    const exitCode = await main(
      [
        "--json",
        "policy",
        "test",
        "--policy",
        fixture.policyPath,
        "--calls",
        fixture.callsPath,
        "--expect",
        fixture.expectPath,
      ],
      fixture.context,
      [policyCommand],
    );

    expect(exitCode, fixture.stderr.join("")).toBe(ExitCode.ok);
    expect(fixture.stdout).toHaveLength(1);
    expect(parseJson(PolicyTestResultSchema, fixture.stdout[0] ?? "").results).toMatchObject([
      { id: "read_one", decision: "allow", ruleId: "allow_read" },
    ]);
    expect(fixture.stderr).toEqual([]);
  });

  it("runs without expectations and reports each evaluation", async () => {
    const fixture = await createFixture({});

    const exitCode = await main(
      ["policy", "test", "--policy", fixture.policyPath, "--calls", fixture.callsPath],
      fixture.context,
      [policyCommand],
    );

    expect(exitCode).toBe(ExitCode.ok);
    expect(fixture.stdout.join("")).toContain("read_one");
    expect(fixture.stderr).toEqual([]);
  });

  it("returns failure and a safe diff when expectations do not match", async () => {
    const fixture = await createFixture({
      expectations: JSON.stringify({ id: "read_one", decision: "deny" }),
    });

    const exitCode = await main(
      [
        "--json",
        "policy",
        "test",
        "--policy",
        fixture.policyPath,
        "--calls",
        fixture.callsPath,
        "--expect",
        fixture.expectPath,
      ],
      fixture.context,
      [policyCommand],
    );

    expect(exitCode).toBe(ExitCode.failure);
    expect(parseJson(PolicyTestResultSchema, fixture.stdout[0] ?? "").mismatches).toMatchObject([
      { id: "read_one", code: "decision_mismatch" },
    ]);
    expect(fixture.stderr).toEqual(["policy_test_failed\n"]);
  });

  it("detects missing, extra, and rule-id-mismatched expectations", async () => {
    const fixture = await createFixture({
      calls: `${callLine}\n${JSON.stringify({
        id: "read_two",
        toolId: "fs.read",
        args: { path: "/workspace/file" },
      })}`,
      expectations: [
        JSON.stringify({ id: "read_one", decision: "allow", ruleId: "wrong_rule" }),
        JSON.stringify({ id: "unused", decision: "deny" }),
      ].join("\n"),
    });

    const exitCode = await main(
      [
        "--json",
        "policy",
        "test",
        "--policy",
        fixture.policyPath,
        "--calls",
        fixture.callsPath,
        "--expect",
        fixture.expectPath,
      ],
      fixture.context,
      [policyCommand],
    );

    expect(exitCode).toBe(ExitCode.failure);
    expect(parseJson(PolicyTestResultSchema, fixture.stdout[0] ?? "").mismatches).toMatchObject([
      { id: "read_one", code: "rule_id_mismatch" },
      { id: "read_two", code: "expectation_missing" },
      { id: "unused", code: "call_missing" },
    ]);
  });

  it("rejects duplicate call identifiers", async () => {
    const fixture = await createFixture({ calls: `${callLine}\n${callLine}` });

    const exitCode = await main(
      ["policy", "test", "--policy", fixture.policyPath, "--calls", fixture.callsPath],
      fixture.context,
      [policyCommand],
    );

    expect(exitCode).toBe(ExitCode.failure);
    expect(fixture.stderr).toEqual(["policy_calls_duplicate_id\n"]);
  });

  it("does not print malformed fixture content", async () => {
    const canary = "policy-fixture-secret@example.test";
    const fixture = await createFixture({ calls: `${canary}\n` });

    const exitCode = await main(
      ["policy", "test", "--policy", fixture.policyPath, "--calls", fixture.callsPath],
      fixture.context,
      [policyCommand],
    );

    expect(exitCode).toBe(ExitCode.failure);
    expect(fixture.stderr.join("")).toContain("contract_invalid");
    expect(fixture.stderr.join("")).not.toContain(canary);
    expect(fixture.stdout).toEqual([]);
  });
});

describe("harness policy lint", () => {
  it("passes a valid policy and returns its empty diagnostic report as JSON", async () => {
    const fixture = await createFixture({});

    const exitCode = await main(
      ["--json", "policy", "lint", "--policy", fixture.policyPath],
      fixture.context,
      [policyCommand],
    );

    expect(exitCode).toBe(ExitCode.ok);
    expect(fixture.stdout).toHaveLength(1);
    expect(parseJson(PolicyLintResultSchema, fixture.stdout[0] ?? "")).toEqual({ diagnostics: [] });
  });

  it("returns failure when lint reports errors", async () => {
    const fixture = await createFixture({
      policy: `version: 1
defaultDecision: deny
rules:
  - id: missing_reason
    match:
      tools: [fs.read]
    decision: deny
`,
    });

    const exitCode = await main(
      ["policy", "lint", "--policy", fixture.policyPath],
      fixture.context,
      [policyCommand],
    );

    expect(exitCode).toBe(ExitCode.failure);
    expect(fixture.stdout.join("")).toContain("error: missing_reason missing_reason");
    expect(fixture.stderr).toEqual(["policy_lint_failed\n"]);
    expect(fixture.configLoads()).toBe(0);
  });

  it("writes only safe error codes for malformed policy data", async () => {
    const canary = "policy-description-secret";
    const fixture = await createFixture({ policy: `version: ${canary}\n` });

    const exitCode = await main(
      ["policy", "lint", "--policy", fixture.policyPath],
      fixture.context,
      [policyCommand],
    );

    expect(exitCode).toBe(ExitCode.failure);
    expect(fixture.stdout.join("")).toContain("error: policy_invalid");
    expect(fixture.stderr).toEqual(["policy_lint_failed\n"]);
    expect(fixture.stderr.join("")).not.toContain(canary);
  });
});
