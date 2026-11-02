// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, it } from "vitest";

it("builds and loads the sample server with the Compose entry point", () => {
  const cwd = resolve(import.meta.dirname, "../..");
  execFileSync(
    process.execPath,
    ["node_modules/typescript/bin/tsc", "-p", "test/fixtures/sample-mcp-server/tsconfig.json"],
    { cwd, encoding: "utf8", timeout: 30_000 },
  );
  const output = execFileSync(
    process.execPath,
    [
      "--import",
      "./test/fixtures/sample-mcp-server/dist/server.js",
      "--eval",
      "process.exit(0)",
    ],
    { cwd, encoding: "utf8", timeout: 10_000 },
  );

  expect(output).toBe("");
});
