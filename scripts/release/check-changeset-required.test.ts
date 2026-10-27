// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { evaluateChangesetRequirement, type ChangesetReader } from "./check-changeset-required.js";

const manifestPath = "packages/sdk/package.json";
const manifest = {
  name: "@rovinos/sdk",
  version: "0.0.0",
  description: "Synthetic package",
  dependencies: { "@rovinos/cli": "^0.0.0", zod: "4.6.7" },
};

function reader(
  changes: ReturnType<ChangesetReader["diff"]>,
  pending = false,
  after: Record<string, unknown> = { ...manifest, version: "0.1.0" },
): ChangesetReader {
  return {
    diff: () => changes,
    hasPendingChangesets: () => pending,
    readFile: (revision, path) => {
      if (path === ".changeset/config.json") {
        return JSON.stringify({
          fixed: [["@rovinos/sdk", "@rovinos/cli"]],
          ignore: ["@rovinos/core"],
        });
      }
      if (path === manifestPath) {
        return JSON.stringify(revision === "base" ? manifest : after);
      }
      if (path === "packages/cli/package.json") {
        return JSON.stringify({
          name: "@rovinos/cli",
          version: revision === "base" ? "0.0.0" : "0.1.0",
        });
      }
      if (path === "packages/core/package.json") {
        return JSON.stringify({
          name: "@rovinos/core",
          version: revision === "base" ? "0.0.0" : "0.1.0",
        });
      }
      throw new Error("unexpected_test_file");
    },
  };
}

const versionDiff = [
  { status: "M", path: manifestPath },
  { status: "M", path: "packages/cli/package.json" },
  { status: "A", path: "packages/sdk/CHANGELOG.md" },
  { status: "D", path: ".changeset/synthetic-release.md" },
];

describe("changeset requirement", () => {
  it("rejects a package code change without a changeset", () => {
    expect(
      evaluateChangesetRequirement(reader([{ status: "M", path: "packages/sdk/src/index.ts" }])),
    ).toBe("changeset_required");
  });

  it("runs normal status for code changes with a changeset", () => {
    expect(
      evaluateChangesetRequirement(
        reader(
          [
            { status: "M", path: "packages/sdk/src/index.ts" },
            { status: "A", path: ".changeset/synthetic-new.md" },
          ],
          true,
        ),
      ),
    ).toBe("changeset_status_required");
  });

  it("allows documentation-only changes without requiring a changeset", () => {
    expect(
      evaluateChangesetRequirement(
        reader([
          { status: "M", path: "packages/sdk/README.md" },
          { status: "M", path: "docs/releasing.md" },
        ]),
      ),
    ).toBe("changeset_status_required");
  });

  it("exempts a genuine version PR with only internal dependency range updates", () => {
    expect(
      evaluateChangesetRequirement(
        reader(versionDiff, false, {
          ...manifest,
          version: "0.1.0",
          dependencies: { ...manifest.dependencies, "@rovinos/cli": "^0.1.0" },
        }),
      ),
    ).toBe("version_pr");
  });

  it("allows version changes to ignored packages", () => {
    expect(
      evaluateChangesetRequirement(
        reader([...versionDiff, { status: "M", path: "packages/core/package.json" }]),
      ),
    ).toBe("version_pr");
  });

  it.each(["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"])(
    "allows only matching internal version updates in %s",
    (field) => {
      for (const prefix of ["", "^", "~", "workspace:", "workspace:^", "workspace:~"]) {
        const input = reader(versionDiff);
        expect(
          evaluateChangesetRequirement({
            ...input,
            readFile: (revision, path) =>
              path === manifestPath
                ? JSON.stringify({
                    name: manifest.name,
                    version: revision === "base" ? "0.0.0" : "0.1.0",
                    [field]: {
                      "@rovinos/cli": `${prefix}${revision === "base" ? "0.0.0" : "0.1.0"}`,
                      "@rovinos/core": "workspace:^",
                    },
                  })
                : input.readFile(revision, path),
          }),
        ).toBe("version_pr");
      }
    },
  );

  it("allows a manifest with only an internal dependency version update", () => {
    expect(
      evaluateChangesetRequirement(
        reader(versionDiff, false, {
          ...manifest,
          dependencies: { ...manifest.dependencies, "@rovinos/cli": "^0.1.0" },
        }),
      ),
    ).toBe("version_pr");
  });

  it.each(["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"])(
    "rejects added dependency entries in %s",
    (field) => {
      expect(
        evaluateChangesetRequirement(
          reader(versionDiff, false, {
            ...manifest,
            version: "0.1.0",
            [field]: { ...manifest.dependencies, "@rovinos/new": "^0.1.0" },
          }),
        ),
      ).toBe("changeset_required");
    },
  );

  it.each([
    { ...manifest, version: "0.1.0", dependencies: { ...manifest.dependencies, zod: "4.7.0" } },
    { ...manifest, version: "0.1.0", dependencies: { "@rovinos/cli": "^0.1.0" } },
    {
      ...manifest,
      version: "0.1.0",
      dependencies: { ...manifest.dependencies, "@rovinos/cli": "^9.0.0" },
    },
    {
      ...manifest,
      version: "0.1.0",
      dependencies: { ...manifest.dependencies, "@rovinos/cli": "~0.1.0" },
    },
    { ...manifest, version: "0.1.0", description: "Changed description" },
    { ...manifest, version: "0.1.0", scripts: { postinstall: "unexpected" } },
    { ...manifest, name: "@rovinos/unknown", version: "0.1.0" },
  ])("rejects non-version manifest changes: %j", (after) => {
    expect(evaluateChangesetRequirement(reader(versionDiff, false, after))).toBe(
      "changeset_required",
    );
  });

  it.each([
    { status: "M", path: "packages/sdk/src/index.ts" },
    { status: "M", path: "packages/sdk/README.md" },
    { status: "M", path: "packages/sdk/fixtures/package.json" },
    { status: "A", path: "packages/new/package.json" },
    { status: "D", path: manifestPath },
  ])("rejects additional package changes: %j", (change) => {
    expect(evaluateChangesetRequirement(reader([...versionDiff, change]))).toBe(
      "changeset_required",
    );
  });

  it("treats deleted plus newly added changesets as a normal PR", () => {
    expect(
      evaluateChangesetRequirement(
        reader([...versionDiff, { status: "A", path: ".changeset/synthetic-new.md" }], true),
      ),
    ).toBe("changeset_status_required");
  });

  it.each([
    { changesets: [] },
    { changesets: [{ status: "M", path: ".changeset/synthetic-release.md" }] },
    { changesets: [{ status: "D", path: ".changeset/README.md" }] },
    { changesets: [{ status: "D", path: ".changeset/nested/synthetic-release.md" }] },
  ])("requires a consumed changeset, not just version edits: %j", ({ changesets }) => {
    expect(
      evaluateChangesetRequirement(reader([{ status: "M", path: manifestPath }, ...changesets])),
    ).toBe("changeset_required");
  });

  it("compares parsed JSON independent of field order and whitespace", () => {
    expect(
      evaluateChangesetRequirement(
        reader(versionDiff, false, {
          dependencies: manifest.dependencies,
          description: manifest.description,
          version: "0.1.0",
          name: manifest.name,
        }),
      ),
    ).toBe("version_pr");
  });

  it("rejects manifests outside the fixed and ignored groups", () => {
    const input = reader(versionDiff);
    expect(
      evaluateChangesetRequirement({
        ...input,
        readFile: (revision, path) =>
          path === ".changeset/config.json"
            ? '{"fixed":[],"ignore":[]}'
            : input.readFile(revision, path),
      }),
    ).toBe("changeset_required");
  });
});
