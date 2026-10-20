// SPDX-License-Identifier: Apache-2.0
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CompositeSecretResolver,
  HarnessConfigSchema,
  loadConfig as loadConfigFromFile,
  Secret,
} from "@harness/config";
import { DoctorResultsSchema, parseJson, type DoctorCheckStatus } from "@harness/schemas";
import { AkvSecretResolverError } from "@harness/vault";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliContext } from "../command.js";
import { ExitCode } from "../exit-codes.js";
import { createOutput } from "../output.js";
import { main } from "../main.js";
import { createDoctorCommand } from "./doctor.js";

let temporaryDirectory: string | undefined;

function createContext(loadConfigForTest: CliContext["loadConfig"]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const context: CliContext = {
    loadConfig: loadConfigForTest,
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
  vi.useRealTimers();
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
        { id: "policy_configured", status: "warn", code: "policy_default_deny" },
        { id: "secret_refs_resolvable", status: "ok", code: "secret_refs_resolvable" },
        { id: "worker_queue_reachable", status: "ok", code: "worker_queue_reachable" },
      ]),
    );
    expect(stdout.join("")).not.toContain(secretValue);
    expect(stderr).toEqual([]);
  });

  it("warns about ephemeral development keys and requires keys in production", async () => {
    await createDataDirectory();
    const config = HarnessConfigSchema.parse({});

    vi.stubEnv("NODE_ENV", "development");
    const development = createContext(() => Promise.resolve(config));
    await main(["--json", "doctor"], development.context);
    const developmentResults = parseJson(DoctorResultsSchema, development.stdout[0] ?? "");
    expect(developmentResults).toContainEqual({
      id: "keys_configured",
      status: "warn",
      code: "keys_ephemeral",
    });

    vi.stubEnv("NODE_ENV", "production");
    const production = createContext(() => Promise.resolve(config));
    const exitCode = await main(["--json", "doctor"], production.context);
    const productionResults = parseJson(DoctorResultsSchema, production.stdout[0] ?? "");

    expect(exitCode).toBe(ExitCode.failure);
    expect(productionResults).toContainEqual({
      id: "keys_configured",
      status: "fail",
      code: "key_config_required",
    });
  });

  it("reports configured key failures with only the key id as detail", async () => {
    await createDataDirectory();
    vi.stubEnv("NODE_ENV", "development");
    const invalidSecret = Buffer.alloc(31, 4).toString("base64");
    vi.stubEnv("HARNESS_DOCTOR_PRIMARY_KEY", invalidSecret);
    const invalidConfig = HarnessConfigSchema.parse({
      keys: {
        currentKeyId: "primary",
        keys: [{ id: "primary", secret: "env:HARNESS_DOCTOR_PRIMARY_KEY" }],
      },
    });
    const invalid = createContext(() => Promise.resolve(invalidConfig));
    await main(["--json", "doctor"], invalid.context);
    const invalidOutput = invalid.stdout.join("") + invalid.stderr.join("");
    const invalidResults = parseJson(DoctorResultsSchema, invalid.stdout[0] ?? "");

    expect(invalidResults).toContainEqual({
      id: "keys_configured",
      status: "fail",
      code: "key_invalid_length",
      detail: "primary",
    });
    expect(invalidOutput).not.toContain(invalidSecret);

    vi.stubEnv("HARNESS_DOCTOR_PRIMARY_KEY", Buffer.alloc(32, 5).toString("base64"));
    vi.stubEnv("HARNESS_DOCTOR_PREVIOUS_KEY", undefined);
    const unresolvedConfig = HarnessConfigSchema.parse({
      keys: {
        currentKeyId: "primary",
        keys: [
          { id: "primary", secret: "env:HARNESS_DOCTOR_PRIMARY_KEY" },
          { id: "previous", secret: "env:HARNESS_DOCTOR_PREVIOUS_KEY" },
        ],
      },
    });
    const unresolved = createContext(() => Promise.resolve(unresolvedConfig));
    await main(["--json", "doctor"], unresolved.context);
    const unresolvedOutput = unresolved.stdout.join("") + unresolved.stderr.join("");
    const unresolvedResults = parseJson(DoctorResultsSchema, unresolved.stdout[0] ?? "");

    expect(unresolvedResults).toContainEqual({
      id: "keys_configured",
      status: "fail",
      code: "key_secret_unavailable",
      detail: "previous",
    });
    expect(unresolvedOutput).not.toContain("HARNESS_DOCTOR_PREVIOUS_KEY");
  });

  it("resolves AKV config references through the injected resolver without printing key material", async () => {
    await createDataDirectory();
    const keyValue = Buffer.alloc(32, 18).toString("base64");
    const reference = "akv:vault-name/harness-key-primary";
    const config = HarnessConfigSchema.parse({
      models: {
        providers: [{ id: "provider", kind: "openai", apiKey: reference }],
      },
      keys: {
        currentKeyId: "primary",
        keys: [{ id: "primary", secret: reference }],
      },
    });
    let resolutions = 0;
    const { context, stdout, stderr } = createContext(() => Promise.resolve(config));
    context.secretResolver = new CompositeSecretResolver({
      akv: {
        resolve: () => {
          resolutions += 1;
          return Promise.resolve(new Secret(keyValue));
        },
      },
    });

    const exitCode = await main(["--json", "doctor"], context, [createDoctorCommand()]);
    const output = stdout.join("") + stderr.join("");
    const results = parseJson(DoctorResultsSchema, stdout[0] ?? "");

    expect(exitCode).toBe(ExitCode.ok);
    expect(results).toContainEqual({
      id: "keys_configured",
      status: "ok",
      code: "keys_configured",
    });
    expect(results).toContainEqual({
      id: "secret_refs_resolvable",
      status: "ok",
      code: "secret_refs_resolvable",
    });
    expect(resolutions).toBeGreaterThan(0);
    expect(output).not.toContain(keyValue);
  });

  it("fails doctor when the installed Key Vault resolver is unavailable", async () => {
    await createDataDirectory();
    const reference = "akv:vault-name/model-api-key";
    const config = HarnessConfigSchema.parse({
      models: {
        providers: [{ id: "provider", kind: "openai", apiKey: reference }],
      },
    });
    const { context, stdout, stderr } = createContext(() => Promise.resolve(config));
    context.secretResolver = {
      resolve: () => Promise.reject(new AkvSecretResolverError("secret_resolver_unavailable")),
    };

    const exitCode = await main(["--json", "doctor"], context, [createDoctorCommand()]);
    const results = parseJson(DoctorResultsSchema, stdout[0] ?? "");

    expect(exitCode).toBe(ExitCode.failure);
    expect(results).toContainEqual({
      id: "secret_refs_resolvable",
      status: "fail",
      code: "secret_resolver_unavailable",
      detail: "akv_model-api-key",
    });
    expect(stderr).toEqual(["doctor_failed\n"]);
  });

  it("forwards the per-check abort signal to configured Key Vault keys", async () => {
    await createDataDirectory();
    vi.useFakeTimers();
    const keyValue = Buffer.alloc(32, 29).toString("base64");
    const reference = "akv:vault-name/harness-key-primary";
    const config = HarnessConfigSchema.parse({
      keys: {
        currentKeyId: "primary",
        keys: [{ id: "primary", secret: reference }],
      },
    });
    const signals: (AbortSignal | undefined)[] = [];
    let resolutions = 0;
    let notifyKeyResolutionStarted: () => void = () => undefined;
    const keyResolutionStarted = new Promise<void>((resolve) => {
      notifyKeyResolutionStarted = resolve;
    });
    const { context, stdout } = createContext(() => Promise.resolve(config));
    context.secretResolver = {
      resolve: (_ref, signal) => {
        resolutions += 1;
        signals.push(signal);
        if (resolutions === 1) {
          return Promise.resolve(new Secret(keyValue));
        }
        notifyKeyResolutionStarted();
        return new Promise((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              reject(new Error("cancelled"));
            },
            { once: true },
          );
        });
      },
    };

    const resultPromise = main(["--json", "doctor"], context, [createDoctorCommand()]);
    await keyResolutionStarted;
    await vi.advanceTimersByTimeAsync(5_000);
    const exitCode = await resultPromise;

    expect(exitCode).toBe(ExitCode.failure);
    expect(resolutions).toBe(2);
    expect(signals[1]?.aborted).toBe(true);
    expect(parseJson(DoctorResultsSchema, stdout[0] ?? "")).toContainEqual({
      id: "keys_configured",
      status: "fail",
      code: "check_timeout",
    });
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
      const secretFailureIsPresent = argv.includes("--json")
        ? parseJson(DoctorResultsSchema, stdout[0] ?? "").some(
            ({ id, status, code }) =>
              id === "secret_refs_resolvable" && status === "fail" && code === "secret_not_found",
          )
        : stdout.join("").includes("secret_not_found");
      expect(secretFailureIsPresent).toBe(true);
    }
  });

  it("reports a safe code when an invalid config file prevents loading", async () => {
    const dataDirectory = await createDataDirectory();
    const invalidValue = "doctor-invalid-config-sensitive-value";
    const configPath = join(dataDirectory, "harness.config.yaml");
    await writeFile(configPath, `run:\n  budgets:\n    maxSteps: ${invalidValue}\n`, "utf8");
    const { context, stdout, stderr } = createContext(() => loadConfigFromFile({ configPath }));

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
