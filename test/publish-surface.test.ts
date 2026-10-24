// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { execFileAsync } from "../scripts/release/check-publish-surface.js";
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const temporaryDirectories: string[] = [];

async function pack(
  packageName: "sdk" | "cli" | "store-sqlite",
  outputPath: string,
): Promise<void> {
  await execFileAsync("corepack", ["yarn", "pack", "--out", outputPath], {
    cwd: join(repositoryRoot, "packages", packageName),
    maxBuffer: 10_000_000,
    timeout: 120_000,
  });
}

describe("published package smoke test", () => {
  afterAll(async () => {
    await Promise.all(
      temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it("installs the SDK and CLI tarballs outside the workspace", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "rovinos-publish-surface-"));
    temporaryDirectories.push(temporaryDirectory);
    const projectDirectory = join(temporaryDirectory, "project");
    const sdkArchive = join(temporaryDirectory, "sdk.tgz");
    const cliArchive = join(temporaryDirectory, "cli.tgz");
    const sqliteArchive = join(temporaryDirectory, "store-sqlite.tgz");
    await mkdir(projectDirectory);
    await pack("sdk", sdkArchive);
    await pack("cli", cliArchive);
    await pack("store-sqlite", sqliteArchive);

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
      },
    };
    await writeFile(join(projectDirectory, "package.json"), JSON.stringify(projectManifest));
    await writeFile(
      join(projectDirectory, "yarn.lock"),
      await readFile(join(repositoryRoot, "yarn.lock"), "utf8"),
    );
    await writeFile(
      join(projectDirectory, ".yarnrc.yml"),
      "nodeLinker: node-modules\nenableScripts: false\nenableTelemetry: false\n",
    );
    await execFileAsync("corepack", ["yarn", "install"], {
      cwd: projectDirectory,
      env: {
        ...process.env,
        YARN_CACHE_FOLDER: join(homedir(), ".yarn", "berry", "cache"),
        YARN_ENABLE_IMMUTABLE_INSTALLS: "false",
        YARN_ENABLE_NETWORK: "false",
      },
      maxBuffer: 10_000_000,
      timeout: 120_000,
    });

    const smokeFile = join(projectDirectory, "sdk-smoke.mjs");
    await writeFile(
      smokeFile,
      [
        'import { createHarness } from "@rovinos/sdk";',
        'import { SqliteEventStore } from "@rovinos/store-sqlite";',
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
    await execFileAsync("corepack", ["yarn", "node", smokeFile], {
      cwd: projectDirectory,
      maxBuffer: 10_000_000,
      timeout: 120_000,
    });

    const version = await execFileAsync("corepack", ["yarn", "run", "harness", "--version"], {
      cwd: projectDirectory,
      maxBuffer: 1_000_000,
      timeout: 30_000,
    });
    const help = await execFileAsync("corepack", ["yarn", "run", "harness", "--help"], {
      cwd: projectDirectory,
      maxBuffer: 1_000_000,
      timeout: 30_000,
    });
    expect(version.stdout).toContain("0.0.0");
    expect(help.stdout).toContain("Usage");
  }, 240_000);
});
