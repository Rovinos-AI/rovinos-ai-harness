// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { execFileAsync } from "../scripts/release/check-publish-surface.js";
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const temporaryDirectories: string[] = [];
const packageManifestSchema = z.looseObject({
  name: z.string(),
  private: z.boolean().optional(),
  version: z.string(),
});

async function privateWorkspacePackages(): Promise<readonly string[]> {
  const packageDirectories = await Promise.all(
    ["packages", "tools"].map(async (workspaceRoot) => {
      const directory = join(repositoryRoot, workspaceRoot);
      const entries = await readdir(directory, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(directory, entry.name, "package.json"));
    }),
  );
  const manifests = await Promise.all(
    packageDirectories
      .flat()
      .map(async (manifestPath) =>
        packageManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8"))),
      ),
  );
  return manifests.filter((manifest) => manifest.private === true).map((manifest) => manifest.name);
}

function codeExamples(markdown: string): readonly string[] {
  return [...markdown.matchAll(/```[^\n]*\n([\s\S]*?)```/gu)].map((match) => match[1] ?? "");
}

function privateImportsInExamples(
  markdown: string,
  privatePackages: readonly string[],
): readonly string[] {
  const exampleText = codeExamples(markdown).join("\n");
  return privatePackages
    .filter((packageName) => {
      const escapedName = packageName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      return new RegExp(
        String.raw`(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)["']${escapedName}["']`,
        "u",
      ).test(exampleText);
    })
    .sort();
}

function typescriptExamplesInSection(markdown: string, heading: string): readonly string[] {
  const sectionStart = markdown.indexOf(`## ${heading}`);
  if (sectionStart < 0) {
    throw new Error(`Documentation section is missing: ${heading}`);
  }
  const nextSection = markdown.indexOf("\n## ", sectionStart + heading.length + 3);
  const section = markdown.slice(sectionStart, nextSection < 0 ? undefined : nextSection);
  return [...section.matchAll(/```(?:ts|typescript)[ \t]*\n([\s\S]*?)```/gu)].map(
    (match) => match[1] ?? "",
  );
}

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

  it("rejects private workspace imports in public documentation examples", async () => {
    const privatePackages = await privateWorkspacePackages();
    const docs = await Promise.all(
      ["sdk.md", "quickstart.md"].map((file) =>
        readFile(join(repositoryRoot, "docs", file), "utf8"),
      ),
    );
    expect(docs.flatMap((markdown) => privateImportsInExamples(markdown, privatePackages))).toEqual(
      [],
    );
    expect(
      privateImportsInExamples(
        '```ts\nimport { Principal } from "@rovinos/schemas";\n```',
        privatePackages,
      ),
    ).toEqual(["@rovinos/schemas"]);
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

    const sdkDocs = await readFile(join(repositoryRoot, "docs", "sdk.md"), "utf8");
    const examples = typescriptExamplesInSection(sdkDocs, "Approvals and human input");
    expect(examples).toHaveLength(2);
    const compiledDirectory = join(projectDirectory, "compiled");
    await mkdir(compiledDirectory);
    const exampleFiles = await Promise.all(
      examples.map(async (example, index) => {
        const sourceFile = join(projectDirectory, `sdk-example-${String(index)}.mts`);
        await writeFile(sourceFile, example);
        return sourceFile;
      }),
    );
    await withCommandDiagnostics("TypeScript compile SDK documentation examples", () =>
      execFileAsync(
        process.execPath,
        [
          join(repositoryRoot, "node_modules", "typescript", "bin", "tsc"),
          "--target",
          "ES2022",
          "--module",
          "NodeNext",
          "--moduleResolution",
          "NodeNext",
          "--strict",
          "--skipLibCheck",
          "--types",
          "node",
          "--outDir",
          compiledDirectory,
          ...exampleFiles,
        ],
        { cwd: projectDirectory, maxBuffer: 10_000_000, timeout: 120_000 },
      ),
    );
    const exampleRunner = join(projectDirectory, "run-sdk-examples.mjs");
    await writeFile(
      exampleRunner,
      [
        'import { answerHumanInput } from "./compiled/sdk-example-0.mjs";',
        'import { resolveApproval } from "./compiled/sdk-example-1.mjs";',
        "const calls = [];",
        "const harness = {",
        "  async answerInput(requestId, options) {",
        '    calls.push({ operation: "answerInput", requestId, options });',
        "    return {};",
        "  },",
        "  async resolveApproval(approvalId, decision, options) {",
        '    calls.push({ operation: "resolveApproval", approvalId, decision, options });',
        "    return {};",
        "  },",
        "};",
        'await answerHumanInput(harness, "synthetic-request-id");',
        'await resolveApproval(harness, "synthetic-approval-id");',
        'if (calls.length !== 2 || calls[0]?.options.principal !== "cli.operator" || calls[1]?.options.principal !== "cli.operator") {',
        '  throw new Error("SDK documentation examples did not use validated principals");',
        "}",
      ].join("\n"),
    );
    await withCommandDiagnostics("Run packed SDK documentation examples", () =>
      execFileAsync(process.execPath, [exampleRunner], {
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
    const cliPackage = packageManifestSchema.parse(
      JSON.parse(
        await readFile(join(projectDirectory, "node_modules/@rovinos/cli/package.json"), "utf8"),
      ),
    );
    const help = await withCommandDiagnostics("corepack yarn run harness --help", () =>
      execFileAsync("corepack", ["yarn", "run", "harness", "--help"], {
        cwd: projectDirectory,
        maxBuffer: 1_000_000,
        timeout: 30_000,
      }),
    );
    expect(version.stdout.trim()).toBe(cliPackage.version);
    expect(version.stdout.trim()).not.toBe("0.0.0");
    expect(help.stdout).toContain("Usage");
  }, 240_000);
});
