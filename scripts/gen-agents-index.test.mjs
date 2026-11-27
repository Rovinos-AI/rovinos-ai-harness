// SPDX-License-Identifier: Apache-2.0
// Run: yarn check:agents
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateLayers, replaceBlock, generate } from "./gen-agents-index.mjs";

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
      `${file} is stale; run yarn gen:agents`,
    );
  }
});

test("generated agent blocks contain no spec or task-id lists", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  for (const [file, contents] of generate(root)) {
    if (!file.endsWith("AGENTS.md")) {
      continue;
    }

    const block = contents
      .split("<!-- BEGIN GENERATED: agents-index (node scripts/gen-agents-index.mjs) -->")[1]
      ?.split("<!-- END GENERATED: agents-index -->")[0];
    assert.ok(block, `${file} has a generated block`);
    assert.doesNotMatch(block, /Specs and task ids|TASKS\.md|epic-[^/]+\.md|tasks \d/);
  }
});
