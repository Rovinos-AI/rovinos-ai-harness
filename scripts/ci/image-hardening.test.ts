// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const dockerfiles = ["Dockerfile", "Dockerfile.sandbox"];
const imageLock = readFileSync(resolve(repositoryRoot, "infra/images.lock"), "utf8");

describe.each(dockerfiles)("%s", (dockerfile) => {
  const contents = readFileSync(resolve(repositoryRoot, dockerfile), "utf8");

  it("uses a numeric non-root USER", () => {
    expect(contents).toMatch(/^USER\s+\d+(?::\d+)?\s*$/m);
  });

  it("does not download or pipe remote scripts during the build", () => {
    expect(contents).not.toMatch(/^\s*ADD\s+https?:\/\//im);
    expect(contents).not.toMatch(/\bcurl(?:\s+\S+)*\s*\|\s*(?:sh|bash)\b/i);
  });

  it("uses only base images recorded by digest in the image lock", () => {
    const baseImages = [...contents.matchAll(/^FROM\s+(\S+)(?:\s+AS\s+\S+)?$/gim)].map(
      ([, image]) => image,
    );

    expect(baseImages.length).toBeGreaterThan(0);
    expect(baseImages.every((image) => image?.includes("@sha256:") === true)).toBe(true);
    expect(baseImages.every((image) => imageLock.split("\n").includes(image ?? ""))).toBe(true);
  });
});
