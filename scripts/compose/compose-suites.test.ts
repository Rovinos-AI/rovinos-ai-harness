// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { composeIntegrationSuites } from "../../vitest.config.js";

const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const startsCompose = /"compose"|runNetworkIsolationCompose|composeArgs/u;

it("lists every integration suite that starts a Compose stack", () => {
  const suites = execFileSync("git", ["ls-files", "*.int.test.ts"], { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((path) => path !== "" && startsCompose.test(readFileSync(resolve(root, path), "utf8")));

  expect([...composeIntegrationSuites].sort()).toEqual(suites.sort());
});
