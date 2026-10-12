// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretRefSchema } from "@harness/schemas";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_DOCTOR_TIMEOUT_MS,
  DOCTOR_CHECKS,
  runDoctor,
  type DoctorCheck,
  type DoctorContext,
} from "./doctor.js";

let temporaryDirectory: string | undefined;

async function createTemporaryDirectory(): Promise<string> {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "harness-doctor-test-"));
  return temporaryDirectory;
}

function context(overrides: Partial<DoctorContext> = {}): DoctorContext {
  return {
    config: {},
    env: {},
    dataDir: tmpdir(),
    resolveSecret: () => Promise.resolve(),
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
    const hangingCheck: DoctorCheck = {
      id: "hanging",
      title: "Hanging check",
      run: () => new Promise(() => undefined),
    };

    const resultPromise = runDoctor(context(), [hangingCheck], 5);
    await vi.advanceTimersByTimeAsync(5);

    await expect(resultPromise).resolves.toEqual([
      { id: "hanging", status: "fail", code: "check_timeout" },
    ]);
    expect(DEFAULT_DOCTOR_TIMEOUT_MS).toBe(5_000);
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
    expect(DOCTOR_CHECKS.map(({ id }) => id)).toEqual([
      "node_version",
      "config_valid",
      "secret_refs_resolvable",
      "data_dir_writable",
    ]);
  });

  it("checks the Node version and configuration status", async () => {
    const checks = DOCTOR_CHECKS.filter(({ id }) => id === "node_version" || id === "config_valid");

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
    const secretCheck = DOCTOR_CHECKS.find(({ id }) => id === "secret_refs_resolvable");
    if (secretCheck === undefined) {
      throw new Error("secret_refs_resolvable check is not registered");
    }

    const results = await runDoctor(
      context({
        config: { first: refs[0], second: refs[1] },
        resolveSecret: (ref) => {
          resolved.push(ref);
          if (ref === refs[0]) {
            return Promise.reject(
              Object.assign(new Error(secretValue), { code: "secret_not_found" }),
            );
          }
          return Promise.resolve();
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

  it("creates and removes a temporary file under the configured data directory", async () => {
    const dataDir = await createTemporaryDirectory();
    const check = DOCTOR_CHECKS.find(({ id }) => id === "data_dir_writable");
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
    const check = DOCTOR_CHECKS.find(({ id }) => id === "data_dir_writable");
    if (check === undefined) {
      throw new Error("data_dir_writable check is not registered");
    }

    await expect(runDoctor(context({ dataDir }), [check])).resolves.toEqual([
      { id: "data_dir_writable", status: "fail", code: "data_dir_write_failed" },
    ]);
  });
});
