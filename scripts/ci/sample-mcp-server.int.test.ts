// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, it } from "vitest";

it("loads the sample server with native Node type stripping, without a bundler", () => {
  const output = execFileSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--disable-warning=ExperimentalWarning",
      "--import",
      "./test/fixtures/sample-mcp-server/server.ts",
      "--eval",
      "process.exit(0)",
    ],
    { cwd: resolve(import.meta.dirname, "../.."), encoding: "utf8", timeout: 10_000 },
  );

  expect(output).toBe("");
});
