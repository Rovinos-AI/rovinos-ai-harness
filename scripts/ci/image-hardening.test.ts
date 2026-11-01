// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const dockerfiles = ["Dockerfile", "Dockerfile.sandbox"];
const imageLock = readFileSync(resolve(repositoryRoot, "infra/images.lock"), "utf8");
const lockedBaseImages = new Set(
  imageLock.split(/\r?\n/u).filter((image) => image !== "" && !image.startsWith("#")),
);
const nonRootUserPattern = /^USER\s+[1-9]\d*(?::[1-9]\d*)?\s*$/m;

function baseImages(contents: string): string[] {
  const stages = new Set<string>();
  const images: string[] = [];

  for (const line of contents.split(/\r?\n/u)) {
    const match = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/iu.exec(line);
    const image = match?.[1];
    const stage = match?.[2];
    if (image !== undefined && !stages.has(image.toLowerCase())) {
      images.push(image);
    }
    if (stage !== undefined) {
      stages.add(stage.toLowerCase());
    }
  }

  return images;
}

describe.each(dockerfiles)("%s", (dockerfile) => {
  const contents = readFileSync(resolve(repositoryRoot, dockerfile), "utf8");

  it("uses a numeric non-root USER", () => {
    expect(contents).toMatch(nonRootUserPattern);
  });

  it("does not download or pipe remote scripts during the build", () => {
    expect(contents).not.toMatch(/^\s*ADD\s+https?:\/\//im);
    expect(contents).not.toMatch(/\bcurl(?:\s+\S+)*\s*\|\s*(?:sh|bash)\b/i);
  });

  it("uses only base images recorded by digest in the image lock", () => {
    const images = baseImages(contents);

    expect(images.length).toBeGreaterThan(0);
    expect(images.every((image) => image.includes("@sha256:"))).toBe(true);
    expect(images.every((image) => lockedBaseImages.has(image))).toBe(true);
  });
});

it.each(["USER 0", "USER 0:0", "USER 0:10002", "USER 10002:0"])(
  "rejects root UID or GID in %s",
  (userInstruction) => {
    expect(userInstruction).not.toMatch(nonRootUserPattern);
  },
);

it("does not contain unused image-lock entries", () => {
  const referencedBaseImages = new Set(
    dockerfiles.flatMap((dockerfile) => {
      const contents = readFileSync(resolve(repositoryRoot, dockerfile), "utf8");
      return baseImages(contents);
    }),
  );

  expect(lockedBaseImages).toEqual(referencedBaseImages);
});
