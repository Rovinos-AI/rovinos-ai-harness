// SPDX-License-Identifier: Apache-2.0
import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseJson } from "@rovinos/schemas";
import { z } from "zod";

/** Execute a command with an explicit argument vector. */
export const execFileAsync = promisify(execFile);
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
const adapterDrivers = new Map([
  ["@rovinos/store-sqlite", "better-sqlite3"],
  ["@rovinos/store-postgres", "pg"],
]);

const packageManifestSchema = z.looseObject({
  name: z.string(),
  private: z.boolean().optional(),
  engines: z.looseObject({ node: z.string() }).optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
  optionalDependencies: z.record(z.string(), z.string()).optional(),
  peerDependencies: z.record(z.string(), z.string()).optional(),
});
type PackageManifest = z.infer<typeof packageManifestSchema>;

const packEventSchema = z.looseObject({ location: z.string().optional() });

/** A file included in a package archive. */
export interface PackedFile {
  readonly path: string;
  readonly size: number;
}

function inspectPackageManifest(manifest: PackageManifest): string[] {
  const violations: string[] = [];
  if (manifest.private === true) {
    violations.push("publish_package_private");
  }
  if (manifest.engines?.node !== ">=26") {
    violations.push("publish_node_engine_invalid");
  }
  const driver = adapterDrivers.get(manifest.name);
  if (
    driver !== undefined &&
    (manifest.dependencies?.[driver] === undefined ||
      manifest.peerDependencies?.["@rovinos/sdk"] === undefined)
  ) {
    violations.push("publish_adapter_dependencies_invalid");
  }
  return violations;
}

function inspectRuntimeDependencies(manifest: PackageManifest): string[] {
  const violations: string[] = [];
  const dependencies = [
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
  for (const dependency of dependencies) {
    const optionalSdkPeer =
      adapterDrivers.has(manifest.name) &&
      dependency.name === "@rovinos/sdk" &&
      dependency.group === "peerDependencies";
    if (dependency.name.startsWith("@rovinos/") && !optionalSdkPeer) {
      violations.push("publish_internal_dependency");
    }
  }
  return violations;
}

function inspectPackageFiles(files: readonly PackedFile[], sizeBudget: number): string[] {
  const violations: string[] = [];
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
  return violations;
}

/** Identify manifest, dependency, and archive violations for a publishable package. */
export function inspectPackedPackage(
  manifest: PackageManifest,
  files: readonly PackedFile[],
): string[] {
  const expectedName = manifest.name;
  const sizeBudget = sizeBudgets.get(expectedName);
  if (sizeBudget === undefined || !publishedNames.has(expectedName)) {
    return ["publish_package_unexpected"];
  }
  return [
    ...new Set([
      ...inspectPackageManifest(manifest),
      ...inspectRuntimeDependencies(manifest),
      ...inspectPackageFiles(files, sizeBudget),
    ]),
  ];
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
    if (/from\s*["']@rovinos\/|import\s*\(\s*["']@rovinos\//u.test(source)) {
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
