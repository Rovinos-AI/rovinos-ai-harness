// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { executeDocTestBlocks } from "../scripts/docs/run-doc-tests.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

it("runs the eval CI documentation commands", () => {
  const markdown = readFileSync(resolve(root, "docs/evals-ci.md"), "utf8");
  expect(() => {
    executeDocTestBlocks(markdown, {
      cwd: root,
      documentPath: "docs/evals-ci.md",
      env: process.env,
    });
  }).not.toThrow();
}, 20_000);
