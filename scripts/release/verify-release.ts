// SPDX-License-Identifier: Apache-2.0
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJson } from "@harness/schemas";
import { z } from "zod";

export const publishedPackageNames: readonly string[] = [
  "@rovinos/sdk",
  "@rovinos/cli",
  "@rovinos/store-sqlite",
  "@rovinos/store-postgres",
];
const publishedPackageNameSet: ReadonlySet<string> = new Set(publishedPackageNames);

const packageManifestSchema = z.looseObject({
  name: z.string(),
  version: z.string(),
  private: z.boolean().optional(),
});

/** Validated metadata read from a published package manifest. */
export type ReleasePackageManifest = z.infer<typeof packageManifestSchema>;

/** Inputs used by the pure release metadata evaluator. */
export interface ReleaseVerificationInput {
  readonly tag: string | undefined;
  readonly packages: readonly ReleasePackageManifest[];
  readonly hasPendingChangesets: boolean;
  readonly dryRun: boolean;
}

const releaseTagPattern = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;

/** Return stable error codes for release metadata that should block publication. */
export function evaluateRelease(input: ReleaseVerificationInput): string[] {
  const manifests = new Map<string, ReleasePackageManifest>();
  const violations: string[] = [];

  for (const manifest of input.packages) {
    if (manifests.has(manifest.name)) {
      violations.push("release_package_duplicate");
    }
    manifests.set(manifest.name, manifest);
    if (!publishedPackageNameSet.has(manifest.name)) {
      violations.push("release_package_unexpected");
    }
  }

  for (const name of publishedPackageNames) {
    const manifest = manifests.get(name);
    if (manifest === undefined) {
      violations.push("release_package_missing");
      continue;
    }
    if (manifest.private === true) {
      violations.push("release_package_private");
    }
  }

  const versions = new Set(
    publishedPackageNames.flatMap((name) => {
      const version = manifests.get(name)?.version;
      return version === undefined ? [] : [version];
    }),
  );
  if (versions.size > 1) {
    violations.push("release_package_versions_mismatch");
  }

  if (!input.dryRun) {
    if (input.tag === undefined || !releaseTagPattern.test(input.tag)) {
      violations.push("release_tag_invalid");
    } else {
      const tagVersion = input.tag.slice(1);
      const allPublishedPackagesPresent = publishedPackageNames.every((name) =>
        manifests.has(name),
      );
      if (
        allPublishedPackagesPresent &&
        publishedPackageNames.some((name) => manifests.get(name)?.version !== tagVersion)
      ) {
        violations.push("release_tag_version_mismatch");
      }
    }
    if (input.hasPendingChangesets) {
      violations.push("release_changeset_pending");
    }
  }

  return [...new Set(violations)];
}

async function readPackageManifests(repositoryRoot: string): Promise<ReleasePackageManifest[]> {
  return Promise.all(
    publishedPackageNames.map(async (name) => {
      const packageDirectory = name.slice("@rovinos/".length);
      const text = await readFile(
        join(repositoryRoot, "packages", packageDirectory, "package.json"),
        "utf8",
      );
      return parseJson(packageManifestSchema, text);
    }),
  );
}

async function hasPendingChangesets(repositoryRoot: string): Promise<boolean> {
  const entries = await readdir(join(repositoryRoot, ".changeset"), { withFileTypes: true });
  return entries.some(
    (entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "README.md",
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const tag = args.find((argument) => !argument.startsWith("--"));
  const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

  let manifests: ReleasePackageManifest[];
  let pendingChangesets: boolean;
  try {
    [manifests, pendingChangesets] = await Promise.all([
      readPackageManifests(repositoryRoot),
      hasPendingChangesets(repositoryRoot),
    ]);
  } catch {
    process.stderr.write("release_manifest_read_failed\n");
    process.exitCode = 1;
    return;
  }

  const violations = evaluateRelease({
    tag,
    packages: manifests,
    hasPendingChangesets: pendingChangesets,
    dryRun,
  });
  if (violations.length > 0) {
    process.stderr.write(`${violations.join("\n")}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write("release_verification_valid\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
