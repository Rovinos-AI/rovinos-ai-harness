// SPDX-License-Identifier: Apache-2.0
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessConfigSchema, loadConfig } from "@harness/config";
import { DoctorResultsSchema, parseJson, type DoctorCheckStatus } from "@harness/schemas";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliContext } from "../command.js";
import { ExitCode } from "../exit-codes.js";
import { createOutput } from "../output.js";
import { main } from "../main.js";
import { createDoctorCommand } from "./doctor.js";

let temporaryDirectory: string | undefined;

function createContext(loadConfig: CliContext["loadConfig"]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const context: CliContext = {
    loadConfig,
    out: createOutput({
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    }),
    clock: { now: () => 0 },
  };
  return { context, stdout, stderr };
}

async function createDataDirectory(): Promise<string> {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "harness-doctor-cli-"));
  vi.stubEnv("HARNESS_DATA_DIR", temporaryDirectory);
  return temporaryDirectory;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  if (temporaryDirectory !== undefined) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = undefined;
  }
});

describe("harness doctor", () => {
  it("prints a human-readable table and treats warnings as successful", async () => {
    await createDataDirectory();
    const check: DoctorCheckStatus = { status: "warn", code: "sample_warn" };
    const { context, stdout, stderr } = createContext(() =>
      Promise.resolve(HarnessConfigSchema.parse({})),
    );

    const exitCode = await main(["doctor"], context, [
      createDoctorCommand([{ id: "sample", title: "Sample", run: () => Promise.resolve(check) }]),
    ]);

    expect(exitCode).toBe(ExitCode.ok);
    expect(stdout.join("")).toBe("id\tstatus\tcode\nsample\twarn\tsample_warn\n");
    expect(stderr).toEqual([]);
  });

  it("returns one schema-validated JSON array and never prints resolved secrets", async () => {
    await createDataDirectory();
    const secretValue = "doctor-cli-secret-value";
    vi.stubEnv("HARNESS_DOCTOR_SECRET", secretValue);
    const config = HarnessConfigSchema.parse({
      models: {
        providers: [{ id: "provider", kind: "openai", apiKey: "env:HARNESS_DOCTOR_SECRET" }],
      },
    });
    const { context, stdout, stderr } = createContext(() => Promise.resolve(config));

    const exitCode = await main(["--json", "doctor"], context, [createDoctorCommand()]);
    const documents = stdout.join("").trim().split("\n");

    expect(exitCode).toBe(ExitCode.ok);
    expect(documents).toHaveLength(1);
    expect(parseJson(DoctorResultsSchema, documents[0] ?? "")).toEqual(
      expect.arrayContaining([
        { id: "config_valid", status: "ok", code: "config_valid" },
        { id: "secret_refs_resolvable", status: "ok", code: "secret_refs_resolvable" },
      ]),
    );
    expect(stdout.join("")).not.toContain(secretValue);
    expect(stderr).toEqual([]);
  });

  it("keeps env and file secret values out of table and JSON failure output", async () => {
    const dataDirectory = await createDataDirectory();
    const envSecret = "doctor-cli-env-secret-value";
    const fileSecret = "doctor-cli-file-secret-value";
    const envName = "HARNESS_DOCTOR_SECRET_20_4";
    const missingEnvName = "HARNESS_DOCTOR_MISSING_SECRET_20_4";
    const secretFile = join(dataDirectory, "doctor-secret");
    await writeFile(secretFile, fileSecret, { mode: 0o600 });
    await chmod(secretFile, 0o600);
    vi.stubEnv(envName, envSecret);
    vi.stubEnv(missingEnvName, undefined);
    const config = HarnessConfigSchema.parse({
      models: {
        providers: [
          { id: "missing", kind: "openai", apiKey: `env:${missingEnvName}` },
          { id: "environment", kind: "openai", apiKey: `env:${envName}` },
          { id: "file", kind: "openai", apiKey: `file:${secretFile}` },
        ],
      },
    });

    for (const argv of [["doctor"], ["--json", "doctor"]]) {
      const { context, stdout, stderr } = createContext(() => Promise.resolve(config));
      const exitCode = await main(argv, context, [createDoctorCommand()]);
      const output = stdout.join("") + stderr.join("");

      expect(exitCode).toBe(ExitCode.failure);
      expect(output).not.toContain(envSecret);
      expect(output).not.toContain(fileSecret);
      expect(output).not.toContain(secretFile);
      expect(stderr).toEqual(["doctor_failed\n"]);
      if (argv.includes("--json")) {
        expect(parseJson(DoctorResultsSchema, stdout[0] ?? "")).toContainEqual(
          expect.objectContaining({
            id: "secret_refs_resolvable",
            status: "fail",
            code: "secret_not_found",
          }),
        );
      } else {
        expect(stdout.join("")).toContain("secret_not_found");
      }
    }
  });

  it("reports a safe code when an invalid config file prevents loading", async () => {
    const dataDirectory = await createDataDirectory();
    const invalidValue = "doctor-invalid-config-sensitive-value";
    const configPath = join(dataDirectory, "harness.config.yaml");
    await writeFile(
      configPath,
      `run:\n  budgets:\n    maxSteps: ${invalidValue}\n`,
      "utf8",
    );
    const { context, stdout, stderr } = createContext(() => loadConfig({ configPath }));

    const exitCode = await main(["--json", "doctor"], context, [createDoctorCommand()]);
    const output = stdout.join("") + stderr.join("");
    const results = parseJson(DoctorResultsSchema, stdout[0] ?? "");

    expect(exitCode).toBe(ExitCode.failure);
    expect(results).toContainEqual({
      id: "config_valid",
      status: "fail",
      code: "config_invalid",
      detail: "config_invalid",
    });
    expect(stderr).toEqual(["doctor_failed\n"]);
    expect(output).not.toContain(invalidValue);
  });

  it.skipIf(process.platform === "win32")(
    "reports world-readable secret files as warnings without printing their values",
    async () => {
      const dataDirectory = await createDataDirectory();
      const secretValue = "doctor-file-secret-value";
      const secretFile = join(dataDirectory, "doctor-key");
      await writeFile(secretFile, secretValue, { mode: 0o644 });
      await chmod(secretFile, 0o644);
      const config = HarnessConfigSchema.parse({
        models: {
          providers: [{ id: "provider", kind: "openai", apiKey: `file:${secretFile}` }],
        },
      });
      const { context, stdout, stderr } = createContext(() => Promise.resolve(config));

      const exitCode = await main(["--json", "doctor"], context, [createDoctorCommand()]);
      const results = parseJson(DoctorResultsSchema, stdout[0] ?? "");

      expect(exitCode).toBe(ExitCode.ok);
      expect(results).toContainEqual({
        id: "secret_refs_resolvable",
        status: "warn",
        code: "secret_file_permissions",
        detail: "file_doctor-key",
      });
      expect(stdout.join("") + stderr.join("")).not.toContain(secretValue);
      expect(stdout.join("") + stderr.join("")).not.toContain(secretFile);
    },
  );

  it("returns failure when config loading or a check fails", async () => {
    const { context, stdout, stderr } = createContext(() =>
      Promise.reject(
        Object.assign(new Error("secret config contents"), { code: "config_invalid" }),
      ),
    );
    const failedCheck: DoctorCheckStatus = { status: "fail", code: "check_failed" };

    const exitCode = await main(["--json", "doctor"], context, [
      createDoctorCommand([
        { id: "failed", title: "Failure", run: () => Promise.resolve(failedCheck) },
      ]),
    ]);
    const output = parseJson(DoctorResultsSchema, stdout[0] ?? "");

    expect(exitCode).toBe(ExitCode.failure);
    expect(output).toEqual([{ id: "failed", ...failedCheck }]);
    expect(stderr).toEqual(["doctor_failed\n"]);
    expect(stdout.join("") + stderr.join("")).not.toContain("secret config contents");
  });
});
