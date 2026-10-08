// SPDX-License-Identifier: Apache-2.0
// Run: node --test scripts/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compressIds, validateLayers, replaceBlock, generate } from "./gen-agents-index.mjs";

test("compressIds builds ranges and sorts numerically", () => {
  assert.equal(
    compressIds(["2.10", "2.1", "2.2", "2.3", "23.1", "4.7"]),
    "2.1-2.3, 2.10, 4.7, 23.1",
  );
  assert.equal(compressIds(["1.9", "1.10"]), "1.9-1.10");
});

test("validateLayers rejects cycles and unknown packages", () => {
  assert.throws(() => validateLayers({ a: ["b"], b: ["a"] }), /cycle/);
  assert.throws(() => validateLayers({ a: ["missing"] }), /unknown/);
  assert.deepEqual(validateLayers({ $comment: "x", a: [], b: ["a"] }), ["a", "b"]);
});

test("replaceBlock requires markers", () => {
  assert.throws(() => replaceBlock("no markers", "x", "f"), /markers/);
});

test("repository index is up to date", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  for (const [file, next] of generate(root)) {
    assert.equal(
      readFileSync(resolve(root, file), "utf8"),
      next,
      `${file} is stale; run node scripts/gen-agents-index.mjs`,
    );
  }
});
