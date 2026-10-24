// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { execFileAsync } from "../scripts/release/check-publish-surface.js";
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const temporaryDirectories: string[] = [];

async function withCommandDiagnostics<T>(command: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    let exitCode = "unknown";
    let stdout = "";
    let stderr = "";
    if (typeof error === "object" && error !== null) {
      if ("code" in error && (typeof error.code === "number" || typeof error.code === "string")) {
        exitCode = String(error.code);
      }
      if ("stdout" in error) {
        if (typeof error.stdout === "string") {
          stdout = error.stdout;
        } else if (Buffer.isBuffer(error.stdout)) {
          stdout = error.stdout.toString("utf8");
        }
      }
      if ("stderr" in error) {
        if (typeof error.stderr === "string") {
          stderr = error.stderr;
        } else if (Buffer.isBuffer(error.stderr)) {
          stderr = error.stderr.toString("utf8");
        }
      }
    }
    const outputTail = (output: string): string => {
      const lines = output.trim().split(/\r?\n/u).slice(-40).join("\n");
      return lines === "" ? "(empty)" : lines;
    };
    expect.fail(
      `${command} failed with exit code ${exitCode}.\nTail of stdout:\n${outputTail(stdout)}\nTail of stderr:\n${outputTail(stderr)}`,
    );
  }
}

async function pack(
  packageName: "sdk" | "cli" | "store-sqlite" | "store-postgres",
  outputPath: string,
): Promise<void> {
  await withCommandDiagnostics(`corepack yarn pack (${packageName})`, () =>
    execFileAsync("corepack", ["yarn", "pack", "--out", outputPath], {
      cwd: join(repositoryRoot, "packages", packageName),
      maxBuffer: 10_000_000,
      timeout: 120_000,
    }),
  );
}

describe("published package smoke test", () => {
  afterAll(async () => {
    await Promise.all(
      temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it("reports the exit code and stderr tail when a child command fails", async () => {
    const stdout = Array.from(
      { length: 45 },
      (_, index) => `stdout line ${String(index + 1)}`,
    ).join("\n");
    const stderr = Array.from(
      { length: 45 },
      (_, index) => `stderr line ${String(index + 1)}`,
    ).join("\n");
    const childFailure = Object.assign(new Error("child command failed"), {
      code: 23,
      stdout,
      stderr,
    });
    const failureMessage = await withCommandDiagnostics("example command", () =>
      Promise.reject(childFailure),
    ).then(
      () => "",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );

    expect(failureMessage).toContain("exit code 23");
    expect(failureMessage).toContain("Tail of stdout:\nstdout line 6");
    expect(failureMessage).toContain("stdout line 45\nTail of stderr:");
    expect(failureMessage).not.toContain("stdout line 1\n");
    expect(failureMessage).toContain("Tail of stderr:\nstderr line 6");
    expect(failureMessage).toContain("stderr line 45");
    expect(failureMessage).not.toContain("stderr line 1\n");
  });

  it("installs the SDK and CLI tarballs outside the workspace", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "rovinos-publish-surface-"));
    temporaryDirectories.push(temporaryDirectory);
    const projectDirectory = join(temporaryDirectory, "project");
    const sdkArchive = join(temporaryDirectory, "sdk.tgz");
    const cliArchive = join(temporaryDirectory, "cli.tgz");
    const sqliteArchive = join(temporaryDirectory, "store-sqlite.tgz");
    const postgresArchive = join(temporaryDirectory, "store-postgres.tgz");
    await mkdir(projectDirectory);
    await pack("sdk", sdkArchive);
    await pack("cli", cliArchive);
    await pack("store-sqlite", sqliteArchive);
    await pack("store-postgres", postgresArchive);

    const projectManifest = {
      name: "rovinos-publish-surface-smoke",
      version: "1.0.0",
      private: true,
      type: "module",
      packageManager: "yarn@4.18.1",
      resolutions: { zod: "4.6.7", "node-releases": "2.0.57" },
      dependenciesMeta: { "better-sqlite3": { built: true } },
      dependencies: {
        "@rovinos/sdk": `file:${relative(projectDirectory, sdkArchive)}`,
        "@rovinos/cli": `file:${relative(projectDirectory, cliArchive)}`,
        "@rovinos/store-sqlite": `file:${relative(projectDirectory, sqliteArchive)}`,
        "@rovinos/store-postgres": `file:${relative(projectDirectory, postgresArchive)}`,
      },
    };
    await writeFile(join(projectDirectory, "package.json"), JSON.stringify(projectManifest));
    await writeFile(
      join(projectDirectory, "yarn.lock"),
      await readFile(join(repositoryRoot, "yarn.lock"), "utf8"),
    );
    await writeFile(
      join(projectDirectory, ".yarnrc.yml"),
      "nodeLinker: node-modules\nenableScripts: false\nenableTelemetry: false\nenableGlobalCache: true\n",
    );
    await withCommandDiagnostics("corepack yarn install", () =>
      execFileAsync("corepack", ["yarn", "install"], {
        cwd: projectDirectory,
        env: {
          ...process.env,
          // This temporary project has a different dependency graph from the copied lockfile.
          YARN_ENABLE_IMMUTABLE_INSTALLS: "false",
          // The repository install already ran in hardened mode; this install uses its validated lockfile
          // and local tarballs offline.
          YARN_ENABLE_HARDENED_MODE: "0",
          YARN_ENABLE_NETWORK: "0",
        },
        maxBuffer: 10_000_000,
        timeout: 120_000,
      }),
    );

    const smokeFile = join(projectDirectory, "sdk-smoke.mjs");
    await writeFile(
      smokeFile,
      [
        'import { createHarness } from "@rovinos/sdk";',
        'import { SqliteEventStore } from "@rovinos/store-sqlite";',
        'import "@rovinos/cli/programmatic";',
        'import "@rovinos/store-postgres";',
        'import { readFile } from "node:fs/promises";',
        'const cliEntry = import.meta.resolve("@rovinos/cli/programmatic");',
        'const approvalHtml = await readFile(new URL("./assets/approval.html", cliEntry), "utf8");',
        'if (!approvalHtml.includes("<!doctype html")) throw new Error("approval_asset_missing");',
        'const sqliteEntry = import.meta.resolve("@rovinos/store-sqlite");',
        'await readFile(new URL("./migrations/sqlite/0001_init.sql", sqliteEntry), "utf8");',
        'const postgresEntry = import.meta.resolve("@rovinos/store-postgres");',
        'await readFile(new URL("./migrations/postgres/0001_init.sql", postgresEntry), "utf8");',
        "const harness = await createHarness({",
        "  config: {},",
        "  overrides: {",
        `    store: new SqliteEventStore(${JSON.stringify(join(projectDirectory, "events.sqlite"))}),`,
        '    model: { complete: async () => ({ parts: [{ type: "text", text: "synthetic completion" }], usage: { inputTokens: 2, outputTokens: 3 }, finishReason: "stop", provider: "test", model: "test-model", latencyMs: 0, schemaValid: true, repairAttempts: 0, fallbackDepth: 0, providerBlobs: null }) },',
        "    transientVault: true,",
        `    dataDir: ${JSON.stringify(join(projectDirectory, "runtime-data"))},`,
        "  },",
        "});",
        "try {",
        '  const started = await harness.startRun({ goal: "synthetic smoke test" });',
        '  let status = "pending";',
        '  for (let attempt = 0; attempt < 300 && status !== "completed"; attempt += 1) {',
        "    status = (await harness.getRun(started.runId)).status;",
        '    if (status !== "completed") await new Promise((resolve) => setTimeout(resolve, 10));',
        "  }",
        '  if (status !== "completed") throw new Error("sdk_smoke_failed");',
        "} finally {",
        "  await harness.close();",
        "}",
      ].join("\n"),
    );
    await withCommandDiagnostics("corepack yarn node sdk-smoke.mjs", () =>
      execFileAsync("corepack", ["yarn", "node", smokeFile], {
        cwd: projectDirectory,
        maxBuffer: 10_000_000,
        timeout: 120_000,
      }),
    );

    const version = await withCommandDiagnostics("corepack yarn run harness --version", () =>
      execFileAsync("corepack", ["yarn", "run", "harness", "--version"], {
        cwd: projectDirectory,
        maxBuffer: 1_000_000,
        timeout: 30_000,
      }),
    );
    const help = await withCommandDiagnostics("corepack yarn run harness --help", () =>
      execFileAsync("corepack", ["yarn", "run", "harness", "--help"], {
        cwd: projectDirectory,
        maxBuffer: 1_000_000,
        timeout: 30_000,
      }),
    );
    expect(version.stdout).toContain("0.0.0");
    expect(help.stdout).toContain("Usage");
  }, 240_000);
});
