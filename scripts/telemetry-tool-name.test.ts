// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const telemetryToolName = ["harness", "telemetry", "emit"].join(".");
const allowedLiteralFiles = new Set([
  "packages/schemas/src/primitives.ts",
  "packages/app-telemetry/src/types.ts",
]);

describe("shared app telemetry tool name", () => {
  it("limits the tool-name literal to schemas and the app telemetry shim", () => {
    const trackedFiles = execFileSync(
      "git",
      ["ls-files", "-z", "--", "packages/", "test/", "scripts/"],
      { cwd: root },
    )
      .toString("utf8")
      .split("\0")
      .filter((path) => /\.(?:ts|tsx|html)$/u.test(path));
    const occurrences = trackedFiles.flatMap((path) => {
      const count = readFileSync(join(root, path), "utf8").split(telemetryToolName).length - 1;
      return count === 0 ? [] : [{ path, count }];
    });

    expect(occurrences).toEqual([
      { path: "packages/app-telemetry/src/types.ts", count: 1 },
      { path: "packages/schemas/src/primitives.ts", count: 1 },
    ]);
    expect(occurrences.every(({ path }) => allowedLiteralFiles.has(path))).toBe(true);
  });
});
