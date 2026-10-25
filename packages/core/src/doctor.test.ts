// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretRefSchema } from "@rovinos/schemas";
import { AkvSecretResolverError } from "@rovinos/vault";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_DOCTOR_TIMEOUT_MS,
  doctorChecks,
  registerDoctorCheck,
  runDoctor,
  type DoctorCheck,
  type DoctorContext,
} from "./doctor.js";
import { resolveDataDir } from "./runtime-data-dir.js";

let temporaryDirectory: string | undefined;

async function createTemporaryDirectory(): Promise<string> {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "harness-doctor-test-"));
  return temporaryDirectory;
}

function context(overrides: Partial<DoctorContext> = {}): DoctorContext {
  return {
    config: {},
    secretRefs: [],
    env: {},
    dataDir: tmpdir(),
    resolveSecret: () => Promise.resolve(undefined),
    ...overrides,
  };
}

afterEach(async () => {
  vi.useRealTimers();
  if (temporaryDirectory !== undefined) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = undefined;
  }
});

describe("doctor registry", () => {
  it("runs checks sequentially and preserves ok, warn, and fail statuses", async () => {
    const order: string[] = [];
    const checks: DoctorCheck[] = [
      {
        id: "first",
        title: "First check",
        run: async () => {
          order.push("first-start");
          await Promise.resolve();
          order.push("first-end");
          return { status: "ok", code: "first_ok" };
        },
      },
      {
        id: "second",
        title: "Second check",
        run: () => {
          order.push("second");
          return Promise.resolve({ status: "warn", code: "second_warn" });
        },
      },
      {
        id: "third",
        title: "Third check",
        run: () => {
          order.push("third");
          return Promise.resolve({ status: "fail", code: "third_failed" });
        },
      },
    ];

    const results = await runDoctor(context(), checks);

    expect(order).toEqual(["first-start", "first-end", "second", "third"]);
    expect(results.map(({ status }) => status)).toEqual(["ok", "warn", "fail"]);
  });

  it("turns a hung check into check_timeout using the per-check timeout", async () => {
    vi.useFakeTimers();
    let checkSignal: AbortSignal | undefined;
    const hangingCheck: DoctorCheck = {
      id: "hanging",
      title: "Hanging check",
      run: (ctx) => {
        checkSignal = ctx.signal;
        return new Promise(() => undefined);
      },
    };

    const resultPromise = runDoctor(context(), [hangingCheck], 5);
    await vi.advanceTimersByTimeAsync(5);

    await expect(resultPromise).resolves.toEqual([
      { id: "hanging", status: "fail", code: "check_timeout" },
    ]);
    expect(checkSignal?.aborted).toBe(true);
    expect(DEFAULT_DOCTOR_TIMEOUT_MS).toBe(5_000);
  });

  it("handles a rejection after timeout and continues to remaining checks", async () => {
    vi.useFakeTimers();
    let remainingCheckRan = false;
    const lateRejectingCheck: DoctorCheck = {
      id: "late_reject",
      title: "Late rejection",
      run: async (ctx) => {
        await new Promise<void>((resolve) => {
          ctx.signal?.addEventListener(
            "abort",
            () => {
              resolve();
            },
            { once: true },
          );
        });
        await new Promise<void>((resolve) => {
          setTimeout(() => {
            resolve();
          }, 5);
        });
        throw new Error("late failure");
      },
    };
    const remainingCheck: DoctorCheck = {
      id: "remaining",
      title: "Remaining check",
      run: () => {
        remainingCheckRan = true;
        return Promise.resolve({ status: "ok", code: "remaining_ok" });
      },
    };

    const resultsPromise = runDoctor(context(), [lateRejectingCheck, remainingCheck], 5);
    await vi.advanceTimersByTimeAsync(5);

    await expect(resultsPromise).resolves.toEqual([
      { id: "late_reject", status: "fail", code: "check_timeout" },
      { id: "remaining", status: "ok", code: "remaining_ok" },
    ]);
    expect(remainingCheckRan).toBe(true);
    await vi.advanceTimersByTimeAsync(5);
  });

  it("stops secret resolution after a timed-out reference", async () => {
    vi.useFakeTimers();
    const refs = [
      SecretRefSchema.parse("env:FIRST_DOCTOR_SECRET"),
      SecretRefSchema.parse("env:SECOND_DOCTOR_SECRET"),
    ];
    const resolved: string[] = [];
    const secretCheck = doctorChecks().find(({ id }) => id === "secret_refs_resolvable");
    if (secretCheck === undefined) {
      throw new Error("secret_refs_resolvable check is not registered");
    }

    const resultsPromise = runDoctor(
      context({
        config: { first: refs[0], second: refs[1] },
        secretRefs: refs,
        resolveSecret: (ref, signal) => {
          resolved.push(ref);
          return new Promise((resolve) => {
            signal?.addEventListener(
              "abort",
              () => {
                resolve(undefined);
              },
              { once: true },
            );
          });
        },
      }),
      [secretCheck],
      5,
    );
    await vi.advanceTimersByTimeAsync(5);

    await expect(resultsPromise).resolves.toEqual([
      { id: "secret_refs_resolvable", status: "fail", code: "check_timeout" },
    ]);
    expect(resolved).toEqual([refs[0]]);
  });

  it("converts thrown errors to safe failure codes", async () => {
    const failingCheck: DoctorCheck = {
      id: "throws",
      title: "Throwing check",
      run: () => Promise.reject(new Error("sensitive diagnostic data")),
    };

    await expect(runDoctor(context(), [failingCheck])).resolves.toEqual([
      { id: "throws", status: "fail", code: "check_failed" },
    ]);
  });

  it("registers node version, config, secret, and data directory checks", () => {
    expect(doctorChecks().map(({ id }) => id)).toEqual([
      "node_version",
      "config_valid",
      "policy_configured",
      "secret_refs_resolvable",
      "data_dir_writable",
    ]);
  });

  it("warns that the built-in policy denies every tool when no policy file is configured", async () => {
    const check = doctorChecks().find(({ id }) => id === "policy_configured");
    if (check === undefined) {
      throw new Error("policy_configured check is not registered");
    }

    await expect(runDoctor(context({ config: {} }), [check])).resolves.toEqual([
      { id: "policy_configured", status: "warn", code: "policy_default_deny" },
    ]);
    await expect(
      runDoctor(context({ config: { policy: { file: "policy.yaml" } } }), [check]),
    ).resolves.toEqual([{ id: "policy_configured", status: "ok", code: "policy_configured" }]);
  });

  it("checks the Node version and configuration status", async () => {
    const checks = doctorChecks().filter(
      ({ id }) => id === "node_version" || id === "config_valid",
    );

    await expect(
      runDoctor(context({ config: undefined, nodeVersion: "20.11.0" }), checks),
    ).resolves.toEqual([
      { id: "node_version", status: "fail", code: "node_version_unsupported" },
      { id: "config_valid", status: "fail", code: "config_invalid" },
    ]);
    await expect(
      runDoctor(context({ config: {}, nodeVersion: "22.0.0" }), checks),
    ).resolves.toEqual([
      { id: "node_version", status: "ok", code: "node_version" },
      { id: "config_valid", status: "ok", code: "config_valid" },
    ]);
  });

  it("resolves every secret reference and reports only a safe reference name on failure", async () => {
    const secretValue = "doctor-test-secret-value";
    const refs = [
      SecretRefSchema.parse("env:DOCTOR_API_TOKEN"),
      SecretRefSchema.parse("file:/private/path/doctor-key"),
    ];
    const resolved: string[] = [];
    const secretCheck = doctorChecks().find(({ id }) => id === "secret_refs_resolvable");
    if (secretCheck === undefined) {
      throw new Error("secret_refs_resolvable check is not registered");
    }

    const results = await runDoctor(
      context({
        config: { first: refs[0], second: refs[1] },
        secretRefs: refs,
        resolveSecret: (ref) => {
          resolved.push(ref);
          if (ref === refs[0]) {
            return Promise.reject(
              Object.assign(new Error(secretValue), { code: "secret_not_found" }),
            );
          }
          return Promise.resolve(undefined);
        },
      }),
      [secretCheck],
    );

    expect(resolved).toEqual(refs);
    expect(results).toEqual([
      {
        id: "secret_refs_resolvable",
        status: "fail",
        code: "secret_not_found",
        detail: "env_doctor_api_token",
      },
    ]);
    expect(JSON.stringify(results)).not.toContain(secretValue);
    expect(JSON.stringify(results)).not.toContain("/private/path");
  });

  it("reports secret-file permission warnings without treating them as failures", async () => {
    const ref = SecretRefSchema.parse("file:/private/path/doctor-key");
    const secretCheck = doctorChecks().find(({ id }) => id === "secret_refs_resolvable");
    if (secretCheck === undefined) {
      throw new Error("secret_refs_resolvable check is not registered");
    }

    await expect(
      runDoctor(
        context({
          config: { credential: ref },
          secretRefs: [ref],
          resolveSecret: () => Promise.resolve("secret_file_permissions"),
        }),
        [secretCheck],
      ),
    ).resolves.toEqual([
      {
        id: "secret_refs_resolvable",
        status: "warn",
        code: "secret_file_permissions",
        detail: "file_doctor-key",
      },
    ]);
  });

  it("creates and removes a temporary file under the configured data directory", async () => {
    const dataDir = await createTemporaryDirectory();
    const check = doctorChecks().find(({ id }) => id === "data_dir_writable");
    if (check === undefined) {
      throw new Error("data_dir_writable check is not registered");
    }

    await expect(runDoctor(context({ dataDir }), [check])).resolves.toEqual([
      { id: "data_dir_writable", status: "ok", code: "data_dir_writable" },
    ]);
    expect(await (await import("node:fs/promises")).readdir(dataDir)).toEqual([]);
  });

  it("fails when the configured data directory cannot be created", async () => {
    const root = await createTemporaryDirectory();
    const dataDir = join(root, "not-a-directory");
    await writeFile(dataDir, "occupied");
    const check = doctorChecks().find(({ id }) => id === "data_dir_writable");
    if (check === undefined) {
      throw new Error("data_dir_writable check is not registered");
    }

    await expect(runDoctor(context({ dataDir }), [check])).resolves.toEqual([
      { id: "data_dir_writable", status: "fail", code: "data_dir_write_failed" },
    ]);
  });

  it("warns when a valid Key Vault reference has no available resolver", async () => {
    const ref = SecretRefSchema.parse("akv:production-vault/doctor-secret");
    const check = doctorChecks().find(({ id }) => id === "secret_refs_resolvable");
    if (check === undefined) {
      throw new Error("secret_refs_resolvable check is not registered");
    }

    await expect(
      runDoctor(
        context({
          secretRefs: [ref],
          resolveSecret: () =>
            Promise.reject(
              Object.assign(new Error("unavailable"), {
                code: "secret_resolver_unavailable",
              }),
            ),
        }),
        [check],
      ),
    ).resolves.toEqual([
      {
        id: "secret_refs_resolvable",
        status: "warn",
        code: "secret_resolver_unavailable",
        detail: "akv_doctor-secret",
      },
    ]);
  });

  it("fails when the installed Key Vault resolver is unavailable", async () => {
    const ref = SecretRefSchema.parse("akv:production-vault/doctor-secret");
    const check = doctorChecks().find(({ id }) => id === "secret_refs_resolvable");
    if (check === undefined) {
      throw new Error("secret_refs_resolvable check is not registered");
    }

    await expect(
      runDoctor(
        context({
          secretRefs: [ref],
          resolveSecret: () =>
            Promise.reject(new AkvSecretResolverError("secret_resolver_unavailable")),
        }),
        [check],
      ),
    ).resolves.toEqual([
      {
        id: "secret_refs_resolvable",
        status: "fail",
        code: "secret_resolver_unavailable",
        detail: "akv_doctor-secret",
      },
    ]);
  });

  it("does not treat arbitrary config strings as secret references", async () => {
    const check = doctorChecks().find(({ id }) => id === "secret_refs_resolvable");
    if (check === undefined) {
      throw new Error("secret_refs_resolvable check is not registered");
    }
    const resolveSecret = vi.fn(() => Promise.resolve(undefined));

    await expect(
      runDoctor(
        context({
          config: { roles: [{ systemPrompt: "env:PRODUCTION" }] },
          secretRefs: [],
          resolveSecret,
        }),
        [check],
      ),
    ).resolves.toEqual([
      { id: "secret_refs_resolvable", status: "ok", code: "secret_refs_resolvable" },
    ]);
    expect(resolveSecret).not.toHaveBeenCalled();
  });

  it("rejects duplicate check ids and exposes only a frozen registry snapshot", () => {
    const checks = doctorChecks();
    expect(Object.isFrozen(checks)).toBe(true);
    expect(() => {
      Reflect.apply(Array.prototype.splice, checks, [0, 1]);
    }).toThrow();

    let thrown: unknown;
    try {
      registerDoctorCheck({
        id: "node_version",
        title: "Duplicate node check",
        run: () => Promise.resolve({ status: "ok", code: "node_version" }),
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      code: "doctor_check_duplicate",
    });
  });

  it("resolves the data directory with the same override precedence as runtime", () => {
    expect(resolveDataDir({}, "/explicit")).toBe("/explicit");
    expect(resolveDataDir({ HARNESS_DATA_DIR: "/environment" })).toBe("/environment");
    expect(resolveDataDir({})).toBe(process.cwd());
  });

  it("includes the safe config error code in the config check", async () => {
    const check = doctorChecks().find(({ id }) => id === "config_valid");
    if (check === undefined) {
      throw new Error("config_valid check is not registered");
    }

    await expect(
      runDoctor(context({ config: undefined, configErrorCode: "config_invalid" }), [check]),
    ).resolves.toEqual([
      { id: "config_valid", status: "fail", code: "config_invalid", detail: "config_invalid" },
    ]);
  });
});
