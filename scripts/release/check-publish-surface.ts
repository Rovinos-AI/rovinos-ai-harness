// SPDX-License-Identifier: Apache-2.0
import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseJson } from "@rovinos/schemas";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const publishedNames = new Set([
  "@rovinos/sdk",
  "@rovinos/cli",
  "@rovinos/store-sqlite",
  "@rovinos/store-postgres",
]);
const sizeBudgets = new Map([
  ["@rovinos/sdk", 30_000_000],
  ["@rovinos/cli", 40_000_000],
  ["@rovinos/store-sqlite", 10_000_000],
  ["@rovinos/store-postgres", 10_000_000],
]);

const packageManifestSchema = z
  .object({
    name: z.string(),
    private: z.boolean().optional(),
    engines: z.object({ node: z.string() }).passthrough().optional(),
    dependencies: z.record(z.string(), z.string()).optional(),
    optionalDependencies: z.record(z.string(), z.string()).optional(),
    peerDependencies: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();
type PackageManifest = z.infer<typeof packageManifestSchema>;

const packEventSchema = z.object({ location: z.string().optional() }).passthrough();
export interface PackedFile {
  readonly path: string;
  readonly size: number;
}

export function inspectPackedPackage(
  manifest: PackageManifest,
  files: readonly PackedFile[],
): string[] {
  const violations: string[] = [];
  const expectedName = manifest.name;
  const sizeBudget = sizeBudgets.get(expectedName);
  if (sizeBudget === undefined || !publishedNames.has(expectedName)) {
    return ["publish_package_unexpected"];
  }
  if (manifest.private === true) {
    violations.push("publish_package_private");
  }
  if (manifest.engines?.node !== ">=26") {
    violations.push("publish_node_engine_invalid");
  }
  const databaseDriver =
    expectedName === "@rovinos/store-sqlite"
      ? "better-sqlite3"
      : expectedName === "@rovinos/store-postgres"
        ? "pg"
        : undefined;
  if (
    databaseDriver !== undefined &&
    (manifest.dependencies?.[databaseDriver] === undefined ||
      manifest.peerDependencies?.["@rovinos/sdk"] === undefined)
  ) {
    violations.push("publish_adapter_dependencies_invalid");
  }
  const runtimeDependencies = [
    ...Object.keys(manifest.dependencies ?? {}).map((name) => ({
      name,
      group: "dependencies",
    })),
    ...Object.keys(manifest.optionalDependencies ?? {}).map((name) => ({
      name,
      group: "optionalDependencies",
    })),
    ...Object.keys(manifest.peerDependencies ?? {}).map((name) => ({
      name,
      group: "peerDependencies",
    })),
  ];
  for (const dependency of runtimeDependencies) {
    const optionalSdkPeer =
      (expectedName === "@rovinos/store-sqlite" || expectedName === "@rovinos/store-postgres") &&
      dependency.name === "@rovinos/sdk" &&
      dependency.group === "peerDependencies";
    if (
      (dependency.name.startsWith("@rovinos/") || dependency.name.startsWith("@harness/")) &&
      !optionalSdkPeer
    ) {
      violations.push("publish_internal_dependency");
    }
  }
  if (files.length === 0) {
    violations.push("publish_package_empty");
  }
  if (files.reduce((total, file) => total + file.size, 0) > sizeBudget) {
    violations.push("publish_size_budget_exceeded");
  }
  for (const file of files) {
    const path = file.path.replace(/^package\//u, "");
    if (path.endsWith(".tsbuildinfo")) {
      violations.push("publish_build_artifact");
    }
    if (/(?:^|\/)[^/]*\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(path)) {
      violations.push("publish_test_file");
    }
    if (/(?:^|\/)testing(?:\/|\.|$)/u.test(path)) {
      violations.push("publish_testing_helper");
    }
  }
  return [...new Set(violations)];
}

async function workspaceManifests(repositoryRoot: string): Promise<PackageManifest[]> {
  const manifests: PackageManifest[] = [];
  for (const workspaceDirectory of ["packages", "tools"]) {
    const entries = await readdir(join(repositoryRoot, workspaceDirectory), {
      withFileTypes: true,
    });
    for (const entry of entries.filter((candidate) => candidate.isDirectory())) {
      const manifestPath = join(repositoryRoot, workspaceDirectory, entry.name, "package.json");
      const text = await readFile(manifestPath, "utf8");
      manifests.push(parseJson(packageManifestSchema, text));
    }
  }
  return manifests;
}

function inspectWorkspaceManifests(manifests: readonly PackageManifest[]): string[] {
  const violations: string[] = [];
  for (const manifest of manifests) {
    const shouldPublish = publishedNames.has(manifest.name);
    if (!manifest.name.startsWith("@rovinos/")) {
      violations.push("workspace_scope_invalid");
    }
    if (shouldPublish) {
      if (manifest.private === true) {
        violations.push("publish_package_private");
      }
      if (manifest.engines?.node !== ">=26") {
        violations.push("publish_node_engine_invalid");
      }
    } else if (manifest.private !== true) {
      violations.push("workspace_package_not_private");
    }
  }
  for (const name of publishedNames) {
    if (!manifests.some((manifest) => manifest.name === name)) {
      violations.push("publish_package_missing");
    }
  }
  return [...new Set(violations)];
}

async function packFiles(workspaceDirectory: string): Promise<PackedFile[]> {
  const { stdout } = await execFileAsync("corepack", ["yarn", "pack", "--dry-run", "--json"], {
    cwd: workspaceDirectory,
    maxBuffer: 10_000_000,
  });
  const files: PackedFile[] = [];
  for (const line of stdout.split(/\r?\n/u).filter((value) => value.length > 0)) {
    const event = parseJson(packEventSchema, line);
    if (event.location === undefined) {
      continue;
    }
    const packageDirectory = resolve(workspaceDirectory);
    const filePath = resolve(packageDirectory, event.location);
    const relativePath = relative(packageDirectory, filePath);
    if (isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
      throw new Error("publish_pack_path_invalid");
    }
    files.push({ path: event.location, size: (await stat(filePath)).size });
  }
  return files;
}

async function bundledImportViolation(
  packageDirectory: string,
  files: readonly PackedFile[],
): Promise<boolean> {
  for (const file of files) {
    const relativePath = file.path.replace(/^package\//u, "");
    if (!/\.(?:m?js|d\.ts)$/u.test(relativePath)) {
      continue;
    }
    const resolvedPackageDirectory = resolve(packageDirectory);
    const resolvedFilePath = resolve(resolvedPackageDirectory, relativePath);
    const relativeFilePath = relative(resolvedPackageDirectory, resolvedFilePath);
    if (
      isAbsolute(relativeFilePath) ||
      relativeFilePath === ".." ||
      relativeFilePath.startsWith(`..${sep}`)
    ) {
      return true;
    }
    const source = await readFile(resolvedFilePath, "utf8");
    if (/(?:from\s*|import\s*\()\s*["']@(?:harness|rovinos)\//u.test(source)) {
      return true;
    }
  }
  return false;
}

async function main(): Promise<void> {
  const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
  const manifests = await workspaceManifests(repositoryRoot);
  const violations = inspectWorkspaceManifests(manifests);
  for (const name of publishedNames) {
    const packageDirectory = join(repositoryRoot, "packages", name.slice("@rovinos/".length));
    const manifest = manifests.find((candidate) => candidate.name === name);
    if (manifest === undefined) {
      continue;
    }
    const files = await packFiles(packageDirectory);
    violations.push(...inspectPackedPackage(manifest, files));
    if (await bundledImportViolation(packageDirectory, files)) {
      violations.push("publish_internal_import");
    }
  }
  if (violations.length > 0) {
    process.stderr.write(`${[...new Set(violations)].join("\n")}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write("publish_surface_valid\n");
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main().catch(() => {
    process.stderr.write("publish_surface_check_failed\n");
    process.exitCode = 1;
  });
}
