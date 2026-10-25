// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  evaluateRelease,
  publishedPackageNames,
  type ReleasePackageManifest,
} from "./verify-release.js";

function packages(version: string): ReleasePackageManifest[] {
  return publishedPackageNames.map((name) => ({ name, version }));
}

describe("verify release", () => {
  it("accepts a matching tag and fixed package versions", () => {
    expect(
      evaluateRelease({
        tag: "v1.2.3",
        packages: packages("1.2.3"),
        hasPendingChangesets: false,
        dryRun: false,
      }),
    ).toEqual([]);
  });

  it("rejects a tag that does not match the published version", () => {
    expect(
      evaluateRelease({
        tag: "v1.2.4",
        packages: packages("1.2.3"),
        hasPendingChangesets: false,
        dryRun: false,
      }),
    ).toContain("release_tag_version_mismatch");
  });

  it("rejects a published package with a different version", () => {
    const manifests = packages("1.2.3").map((manifest) =>
      manifest.name === "@rovinos/cli" ? { ...manifest, version: "1.2.2" } : manifest,
    );

    expect(
      evaluateRelease({
        tag: "v1.2.3",
        packages: manifests,
        hasPendingChangesets: false,
        dryRun: false,
      }),
    ).toEqual(["release_package_versions_mismatch", "release_tag_version_mismatch"]);
  });

  it("rejects pending changesets on a tagged release", () => {
    expect(
      evaluateRelease({
        tag: "v1.2.3",
        packages: packages("1.2.3"),
        hasPendingChangesets: true,
        dryRun: false,
      }),
    ).toContain("release_changeset_pending");
  });

  it("checks package consistency without rejecting a PR changeset in dry-run mode", () => {
    expect(
      evaluateRelease({
        tag: undefined,
        packages: packages("0.0.0"),
        hasPendingChangesets: true,
        dryRun: true,
      }),
    ).toEqual([]);
  });

  it("rejects missing, unexpected, and private published packages", () => {
    expect(
      evaluateRelease({
        tag: "v1.2.3",
        packages: [
          { name: "@rovinos/sdk", version: "1.2.3" },
          { name: "@rovinos/cli", version: "1.2.3", private: true },
          { name: "@rovinos/other", version: "1.2.3" },
        ],
        hasPendingChangesets: false,
        dryRun: false,
      }),
    ).toEqual(["release_package_unexpected", "release_package_private", "release_package_missing"]);
  });
});
