// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { CliContext } from "./command.js";
import { ExitCode } from "./exit-codes.js";
import { healthcheckCommand } from "./healthcheck.js";
import { main } from "./main.js";
import { createOutput } from "./output.js";

const temporaryDirectories: string[] = [];

function createContext() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const context: CliContext = {
    loadConfig: () => Promise.reject(new Error("Configuration must not be loaded.")),
    out: createOutput({
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    }),
    clock: { now: () => 0 },
  };
  return { context, stdout, stderr };
}

function makeDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "harness-healthcheck-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("checks local data-directory access without loading configuration", async () => {
  vi.stubEnv("HARNESS_DATA_DIR", makeDirectory());
  const { context, stdout, stderr } = createContext();

  await expect(main(["healthcheck"], context, [healthcheckCommand])).resolves.toBe(ExitCode.ok);
  expect(stdout).toEqual(["healthy\n"]);
  expect(stderr).toEqual([]);
});

it("reports only a safe failure code when local state is unavailable", async () => {
  vi.stubEnv("HARNESS_DATA_DIR", join(makeDirectory(), "missing"));
  const { context, stdout, stderr } = createContext();

  await expect(main(["healthcheck"], context, [healthcheckCommand])).resolves.toBe(
    ExitCode.failure,
  );
  expect(stdout).toEqual([]);
  expect(stderr).toEqual(["failure\n"]);
});

it("checks the separate vault directory when configured", async () => {
  vi.stubEnv("HARNESS_DATA_DIR", makeDirectory());
  vi.stubEnv("HARNESS_VAULT_DATA_DIR", join(makeDirectory(), "missing"));
  const { context, stdout, stderr } = createContext();

  await expect(main(["healthcheck"], context, [healthcheckCommand])).resolves.toBe(
    ExitCode.failure,
  );
  expect(stdout).toEqual([]);
  expect(stderr).toEqual(["failure\n"]);
});

it("rejects a data path that is not a directory", async () => {
  const stateFile = join(makeDirectory(), "state");
  writeFileSync(stateFile, "synthetic state");
  vi.stubEnv("HARNESS_DATA_DIR", stateFile);
  const { context, stdout, stderr } = createContext();

  await expect(main(["healthcheck"], context, [healthcheckCommand])).resolves.toBe(
    ExitCode.failure,
  );
  expect(stdout).toEqual([]);
  expect(stderr).toEqual(["failure\n"]);
});

it("emits one validated JSON document when requested", async () => {
  vi.stubEnv("HARNESS_DATA_DIR", makeDirectory());
  const { context, stdout, stderr } = createContext();

  await expect(main(["--json", "healthcheck"], context, [healthcheckCommand])).resolves.toBe(
    ExitCode.ok,
  );
  expect(stdout).toEqual(['{"status":"healthy"}\n']);
  expect(stderr).toEqual([]);
});
