// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { inspectPackedPackage } from "./check-publish-surface.js";

const publishableManifest = {
  name: "@rovinos/sdk",
  private: false,
  engines: { node: ">=26" },
};

describe("publish surface checks", () => {
  it("rejects an unpublished workspace dependency", () => {
    expect(
      inspectPackedPackage(
        {
          ...publishableManifest,
          dependencies: { "@rovinos/internal": "workspace:^" },
        },
        [{ path: "package/dist/index.js", size: 32 }],
      ),
    ).toContain("publish_internal_dependency");
  });

  it("rejects a test file in the packed file list", () => {
    expect(
      inspectPackedPackage(publishableManifest, [
        { path: "package/dist/index.js", size: 32 },
        { path: "package/dist/index.test.js", size: 10 },
      ]),
    ).toContain("publish_test_file");
  });

  it("accepts a clean package under its size budget", () => {
    expect(
      inspectPackedPackage(publishableManifest, [
        { path: "package/package.json", size: 256 },
        { path: "package/dist/index.js", size: 32 },
        { path: "package/dist/index.js.map", size: 64 },
      ]),
    ).toEqual([]);
  });

  it("rejects packages over their size budget", () => {
    expect(
      inspectPackedPackage(publishableManifest, [
        { path: "package/dist/index.js", size: 30_000_001 },
      ]),
    ).toContain("publish_size_budget_exceeded");
  });
});
