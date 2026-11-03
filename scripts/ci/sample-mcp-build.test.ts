// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const fixturePath = "test/fixtures/sample-mcp-server";

it("builds and runs the sample MCP fixture with sibling .js imports", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "sample-mcp-build-"));
  const fixture = resolve(directory, fixturePath);
  try {
    mkdirSync(fixture, { recursive: true });
    cpSync(resolve(root, "tsconfig.base.json"), resolve(directory, "tsconfig.base.json"));
    cpSync(resolve(root, fixturePath, "tsconfig.json"), resolve(fixture, "tsconfig.json"));
    writeFileSync(resolve(directory, "package.json"), '{"type":"module"}');
    symlinkSync(resolve(root, "node_modules"), resolve(directory, "node_modules"), "dir");
    writeFileSync(
      resolve(fixture, "server.ts"),
      'import { ready } from "./dependency.js";\nif (!ready) throw new Error("not_ready");\n',
    );
    writeFileSync(resolve(fixture, "dependency.ts"), "export const ready = true;\n");
    execFileSync(
      process.execPath,
      [resolve(root, "node_modules/typescript/bin/tsc"), "-p", resolve(fixture, "tsconfig.json")],
      { cwd: directory, stdio: "pipe" },
    );
    expect(
      execFileSync(process.execPath, [resolve(fixture, "dist/server.js")], {
        cwd: directory,
        encoding: "utf8",
      }),
    ).toBe("");
    const dockerfile = readFileSync(resolve(root, fixturePath, "Dockerfile"), "utf8");
    expect(dockerfile).toContain("yarn exec tsc -p test/fixtures/sample-mcp-server/tsconfig.json");
    expect(dockerfile).toContain('CMD ["node", "test/fixtures/sample-mcp-server/dist/server.js"]');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
