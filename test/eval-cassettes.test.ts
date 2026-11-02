// SPDX-License-Identifier: Apache-2.0
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CassetteFileSchema } from "@rovinos/models";
import { parseJson } from "@rovinos/schemas";
import { describe, expect, it } from "vitest";

const cassetteDirectory = fileURLToPath(new URL("../examples/evals/cassettes/", import.meta.url));
const piiLikePatterns = [
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu,
  /\b\d{3}-\d{2}-\d{4}\b/u,
  /\b(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/u,
];

async function cassetteFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const children = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? cassetteFiles(path) : [path];
    }),
  );
  return children.flat();
}

describe("example eval cassettes", () => {
  it("are declared synthetic and contain no PII-like values", async () => {
    const files = await cassetteFiles(cassetteDirectory);

    expect(files.length).toBeGreaterThan(0);
    for (const path of files) {
      const text = await readFile(path, "utf8");
      expect(parseJson(CassetteFileSchema, text).containsRealData).toBe(false);
      expect(piiLikePatterns.some((pattern) => pattern.test(text))).toBe(false);
    }
  });
});
