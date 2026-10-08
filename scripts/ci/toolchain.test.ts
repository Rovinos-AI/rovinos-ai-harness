// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function repositoryFiles(directory: string): string[] {
  const ignoredDirectories = new Set([".git", ".yarn", "coverage", "dist", "node_modules"]);
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        files.push(...repositoryFiles(path));
      }
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

function satisfiesNodeEngine(version: string, requirement: string): boolean {
  const actual = version.split(".").map(Number);
  const minimum = requirement.replace(">=", "").split(".").map(Number);
  for (let index = 0; index < minimum.length; index += 1) {
    const difference = (actual[index] ?? 0) - (minimum[index] ?? 0);
    if (difference !== 0) {
      return difference > 0;
    }
  }
  return true;
}

function readManifest(): unknown {
  return JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
}

function getNodeEngine(): string {
  const manifest = readManifest();
  if (typeof manifest !== "object" || manifest === null || !("engines" in manifest)) {
    throw new TypeError("The root manifest must declare Node engine support.");
  }
  const engines = manifest.engines;
  if (typeof engines !== "object" || engines === null || !("node" in engines)) {
    throw new TypeError("The root manifest must declare a Node engine.");
  }
  const node = engines.node;
  if (typeof node !== "string") {
    throw new TypeError("The Node engine must be a string.");
  }
  return node;
}

function getPackageManager(): string {
  const manifest = readManifest();
  if (typeof manifest !== "object" || manifest === null || !("packageManager" in manifest)) {
    throw new TypeError("The root manifest must pin its package manager.");
  }
  const packageManager = manifest.packageManager;
  if (typeof packageManager !== "string") {
    throw new TypeError("The package-manager pin must be a string.");
  }
  return packageManager;
}

it("pins an exact supported Node and Corepack version through mise", () => {
  const mise = readFileSync(join(root, "mise.toml"), "utf8");
  const nodeVersion = /^node = "([^"]+)"$/m.exec(mise)?.[1];
  const corepackVersion = /^"npm:corepack" = "([^"]+)"$/m.exec(mise)?.[1];
  const shellcheckVersion = /^"aqua:koalaman\/shellcheck" = "([^"]+)"$/m.exec(mise)?.[1];
  if (
    nodeVersion === undefined ||
    corepackVersion === undefined ||
    shellcheckVersion === undefined
  ) {
    throw new TypeError("mise.toml must pin Node, Corepack, and ShellCheck.");
  }

  expect(mise).not.toMatch(/^node\.corepack\s*=/m);
  expect(nodeVersion).toMatch(/^22\.\d+\.\d+$/);
  expect(corepackVersion).toMatch(/^\d+\.\d+\.\d+$/);
  expect(shellcheckVersion).toMatch(/^\d+\.\d+\.\d+$/);
  expect(shellcheckVersion).toBe("0.11.0");
  expect(process.versions.node).toBe(nodeVersion);
  expect(execFileSync("corepack", ["--version"], { cwd: root, encoding: "utf8" }).trim()).toBe(
    corepackVersion,
  );
  expect(satisfiesNodeEngine(nodeVersion, getNodeEngine())).toBe(true);
  expect(existsSync(join(root, ".nvmrc"))).toBe(false);
});

it("adds the mise-installed ShellCheck binary to the Azure Pipelines path", () => {
  const pipelineSetup = readFileSync(join(root, "pipelines/templates/node-setup.yml"), "utf8");

  expect(pipelineSetup).toContain('shellcheck_bin="$(mise which shellcheck)"');
  expect(pipelineSetup).toContain('$(dirname "$shellcheck_bin")');
  expect(pipelineSetup).toContain("##vso[task.prependpath]");
});

it("pins Yarn 4 with Corepack's integrity hash", () => {
  const packageManager = getPackageManager();
  const yarnVersion = /^yarn@(4\.\d+\.\d+)\+sha512\.[\w+/=-]+$/.exec(packageManager)?.[1];
  if (yarnVersion === undefined) {
    throw new TypeError("The Yarn pin must include a version and SHA-512 hash.");
  }
  expect(execFileSync("yarn", ["--version"], { cwd: root, encoding: "utf8" }).trim()).toBe(
    yarnVersion,
  );
});

it("uses the required Yarn configuration", () => {
  const yarnrc = readFileSync(join(root, ".yarnrc.yml"), "utf8");

  expect(yarnrc).toMatch(/^nodeLinker: node-modules$/m);
  expect(yarnrc).toMatch(/^enableTelemetry: false$/m);
  expect(yarnrc).toMatch(/^enableGlobalCache: true$/m);
  expect(yarnrc).toMatch(/^defaultSemverRangePrefix: ""$/m);
  expect(yarnrc).toMatch(/^npmMinimalAgeGate: 3d$/m);
  expect(yarnrc).toMatch(/^npmPreapprovedPackages: \[\]$/m);
  expect(yarnrc).toMatch(/^enableScripts: false$/m);
  expect(readFileSync(join(root, "package.json"), "utf8")).toMatch(
    /"esbuild": \{\s+"built": true\s+\}/,
  );
});

it("does not retain legacy workspace or lock files", () => {
  const manager = ["pn", "pm"].join("");

  expect(existsSync(join(root, `${manager}-lock.yaml`))).toBe(false);
  expect(existsSync(join(root, `${manager}-workspace.yaml`))).toBe(false);
});

it("satisfies workspace constraints and the dedupe check", () => {
  expect(() => execFileSync("yarn", ["constraints"], { cwd: root, stdio: "pipe" })).not.toThrow();
  expect(() =>
    execFileSync("yarn", ["dedupe", "--check"], { cwd: root, stdio: "pipe" }),
  ).not.toThrow();
});

it("contains no legacy package-manager references outside historical notes", () => {
  const legacyManager = ["pn", "pm"].join("");
  const historicalNotes = new Set<string>();

  for (const path of repositoryFiles(root)) {
    if (historicalNotes.has(relative(root, path))) {
      continue;
    }
    expect(readFileSync(path, "utf8").includes(legacyManager)).toBe(false);
  }
});
