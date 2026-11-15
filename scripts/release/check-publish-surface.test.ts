// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { inspectPackedPackage } from "./check-publish-surface.ts";

const publishableManifest = {
  name: "@rovinos/sdk",
  private: false,
  engines: { node: ">=26" },
  repository: { url: "git+https://github.com/Rovinos-AI/rovinos-ai-harness.git" },
};
const extensionsManifest = {
  ...publishableManifest,
  name: "@rovinos/extensions",
  peerDependencies: { "@rovinos/sdk": ">=0.3.0 <0.4.0" },
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

  it("rejects a manifest without the GitHub repository URL that npm provenance requires", () => {
    expect(
      inspectPackedPackage({ name: "@rovinos/sdk", private: false, engines: { node: ">=26" } }, [
        { path: "package/dist/index.js", size: 32 },
      ]),
    ).toContain("publish_repository_invalid");
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

  it("accepts the Redis adapter with its client and optional SDK peer", () => {
    expect(
      inspectPackedPackage(
        {
          ...publishableManifest,
          name: "@rovinos/rate-limit-redis",
          dependencies: { ioredis: "6.0.0" },
          peerDependencies: { "@rovinos/sdk": "*" },
        },
        [
          { path: "package/package.json", size: 256 },
          { path: "package/dist/index.js", size: 32 },
        ],
      ),
    ).toEqual([]);
  });

  it("accepts the extensions package and its opt-in testing entry with a bounded SDK peer", () => {
    expect(
      inspectPackedPackage(extensionsManifest, [
        { path: "package/package.json", size: 256 },
        { path: "package/dist/index.js", size: 128 },
        { path: "package/dist/index.d.ts", size: 64 },
        { path: "package/dist/testing.js", size: 128 },
        { path: "package/dist/testing.js.map", size: 64 },
        { path: "package/dist/testing.d.ts", size: 64 },
      ]),
    ).toEqual([]);
  });

  it("accepts the retrieval package with SDK and extensions peers", () => {
    expect(
      inspectPackedPackage(
        {
          ...publishableManifest,
          name: "@rovinos/extension-retrieval",
          peerDependencies: {
            "@rovinos/sdk": "^0.2.0",
            "@rovinos/extensions": "^0.2.0",
          },
          dependencies: { zod: "^4.6.7" },
        },
        [
          { path: "package/package.json", size: 256 },
          { path: "package/dist/index.js", size: 128 },
          { path: "package/dist/index.d.ts", size: 64 },
        ],
      ),
    ).toEqual([]);
  });

  it("rejects an extensions package without its compatible SDK peer range", () => {
    expect(
      inspectPackedPackage({ ...extensionsManifest, peerDependencies: { "@rovinos/sdk": "*" } }, [
        { path: "package/dist/index.js", size: 32 },
      ]),
    ).toContain("publish_extensions_sdk_peer_invalid");
  });

  it("allows the optional Redis adapter peer on the SDK", () => {
    expect(
      inspectPackedPackage(
        {
          ...publishableManifest,
          peerDependencies: { "@rovinos/rate-limit-redis": "*" },
          peerDependenciesMeta: { "@rovinos/rate-limit-redis": { optional: true } },
        },
        [
          { path: "package/package.json", size: 256 },
          { path: "package/dist/index.js", size: 32 },
        ],
      ),
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
