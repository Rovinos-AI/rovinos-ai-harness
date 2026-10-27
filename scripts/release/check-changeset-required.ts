// SPDX-License-Identifier: Apache-2.0
// Version PRs consume changesets; exempt only manifest/changelog changes produced by versioning.
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { parseJson } from "@rovinos/schemas";
import { z } from "zod";

const configSchema = z.looseObject({
  fixed: z.array(z.array(z.string())),
  ignore: z.array(z.string()),
});
const dependencySchema = z.record(z.string(), z.string());
const manifestSchema = z.looseObject({
  name: z.string(),
  version: z.string(),
  dependencies: dependencySchema.optional(),
  devDependencies: dependencySchema.optional(),
  peerDependencies: dependencySchema.optional(),
  optionalDependencies: dependencySchema.optional(),
});
const changeSchema = z.object({ status: z.string(), path: z.string() });
type Change = z.infer<typeof changeSchema>;
type Manifest = z.infer<typeof manifestSchema>;

/** Git and filesystem inputs, injected so the decision needs no repository in unit tests. */
export interface ChangesetReader {
  diff(): readonly Change[];
  readFile(revision: "base" | "head", path: string): string;
  hasPendingChangesets(): boolean;
}

const dependencyFields = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;
const versionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[\w.-]+)?$/u;
const rangePattern = /^(workspace:)?([~^]?)(\d+\.\d+\.\d+(?:-[\w.-]+)?)$/u;
const isChangeset = (path: string): boolean =>
  /^\.changeset\/[^/]+\.md$/u.test(path) && path !== ".changeset/README.md";

function onlyVersionChanges(
  before: Manifest,
  after: Manifest,
  versions: ReadonlyMap<string, string>,
): boolean {
  if (!versionPattern.test(after.version)) {
    return false;
  }
  const normalized = { ...after, version: before.version };
  for (const field of dependencyFields) {
    const oldDependencies = before[field];
    const newDependencies = after[field];
    if (oldDependencies === undefined || newDependencies === undefined) {
      continue;
    }
    const dependencies = { ...newDependencies };
    for (const [name, range] of Object.entries(newDependencies)) {
      const oldRange = oldDependencies[name];
      if (range === oldRange || oldRange === undefined) {
        continue;
      }
      const match = rangePattern.exec(oldRange);
      const version = versions.get(name);
      if (
        name.startsWith("@rovinos/") &&
        match !== null &&
        version !== undefined &&
        range === `${match[1] ?? ""}${match[2] ?? ""}${version}`
      ) {
        dependencies[name] = oldRange;
      }
    }
    normalized[field] = dependencies;
  }
  return isDeepStrictEqual(before, normalized);
}

function isVersionPr(reader: ChangesetReader, changes: readonly Change[]): boolean {
  const changesets = changes.filter((change) => isChangeset(change.path));
  if (
    !changesets.some((change) => change.status === "D") ||
    changesets.some((change) => change.status === "A")
  ) {
    return false;
  }
  const config = parseJson(configSchema, reader.readFile("base", ".changeset/config.json"));
  const allowedNames = new Set([...config.fixed.flat(), ...config.ignore]);
  const manifests: { before: Manifest; after: Manifest }[] = [];
  for (const change of changes.filter((entry) => entry.path.startsWith("packages/"))) {
    if (/^packages\/[^/]+\/CHANGELOG\.md$/u.test(change.path)) {
      continue;
    }
    if (change.status !== "M" || !/^packages\/[^/]+\/package\.json$/u.test(change.path)) {
      return false;
    }
    const before = parseJson(manifestSchema, reader.readFile("base", change.path));
    const after = parseJson(manifestSchema, reader.readFile("head", change.path));
    if (!allowedNames.has(before.name) || before.name !== after.name) {
      return false;
    }
    manifests.push({ before, after });
  }
  const versions = new Map(
    manifests
      .filter(({ before, after }) => before.version !== after.version)
      .map(({ after }) => [after.name, after.version]),
  );
  return manifests.every(({ before, after }) => onlyVersionChanges(before, after, versions));
}

/** Decide whether to skip status for a version PR, reject missing changesets, or run status. */
export function evaluateChangesetRequirement(
  reader: ChangesetReader,
): "version_pr" | "changeset_required" | "changeset_status_required" {
  const changes = reader.diff();
  if (isVersionPr(reader, changes)) {
    return "version_pr";
  }
  if (
    changes.some((change) => change.path.startsWith("packages/") && !change.path.endsWith(".md")) &&
    !reader.hasPendingChangesets()
  ) {
    return "changeset_required";
  }
  return "changeset_status_required";
}

function main(): void {
  const cwd = fileURLToPath(new URL("../../", import.meta.url));
  const git = (...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" });
  try {
    const base = git("merge-base", "origin/main", "HEAD").trim();
    const result = evaluateChangesetRequirement({
      diff: () => {
        const fields = git("diff", "--name-status", "--no-renames", "-z", `${base}...HEAD`)
          .split("\0")
          .slice(0, -1);
        const changes: Change[] = [];
        for (let index = 0; index < fields.length; index += 2) {
          changes.push(changeSchema.parse({ status: fields[index], path: fields[index + 1] }));
        }
        return changes;
      },
      readFile: (revision, path) => git("show", `${revision === "base" ? base : "HEAD"}:${path}`),
      hasPendingChangesets: () =>
        readdirSync(`${cwd}.changeset`, { withFileTypes: true }).some(
          (entry) => entry.isFile() && isChangeset(`.changeset/${entry.name}`),
        ),
    });
    if (result === "changeset_required") {
      process.stderr.write("changeset_required\n");
      process.exitCode = 1;
    } else if (result === "changeset_status_required") {
      execFileSync("yarn", ["changeset", "status", "--since=origin/main"], {
        cwd,
        stdio: "inherit",
      });
    } else {
      process.stdout.write("changeset_version_pr\n");
    }
  } catch {
    process.stderr.write("changeset_check_failed\n");
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
