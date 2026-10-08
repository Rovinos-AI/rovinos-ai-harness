// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { checkSpdx } from "./check-spdx.js";

const temporaryDirectories: string[] = [];

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "check-spdx-"));
  temporaryDirectories.push(root);
  return root;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("reports missing headers with paths relative to the scanned root", () => {
  const root = createRoot();
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "missing.ts"), "export {};\n");

  expect(checkSpdx(root)).toEqual(["src/missing.ts"]);
});

it("accepts and repairs headers after a shebang", () => {
  const root = createRoot();
  const script = join(root, "script.mjs");
  writeFileSync(script, "#!/usr/bin/env node\nprocess.exit(0);\n");

  expect(checkSpdx(root)).toEqual(["script.mjs"]);
  expect(checkSpdx(root, true)).toEqual([]);
  expect(readFileSync(script, "utf8")).toBe(
    "#!/usr/bin/env node\n// SPDX-License-Identifier: Apache-2.0\nprocess.exit(0);\n",
  );
});

it("ignores excluded directories and yarn.lock", () => {
  const root = createRoot();
  for (const directory of ["node_modules", "dist", "coverage", "src/__golden__", ".git"]) {
    const excluded = join(root, directory);
    mkdirSync(excluded, { recursive: true });
    writeFileSync(join(excluded, "ignored.ts"), "export {};\n");
  }
  writeFileSync(join(root, "yarn.lock"), "missing SPDX header\n");

  expect(checkSpdx(root)).toEqual([]);
});

it("uses hash-style headers for shell and YAML files", () => {
  const root = createRoot();
  writeFileSync(join(root, "workflow.yml"), "# SPDX-License-Identifier: Apache-2.0\n");
  writeFileSync(join(root, "hook.sh"), "echo ready\n");

  expect(checkSpdx(root)).toEqual(["hook.sh"]);
});

it("--fix repairs the scanned tree and the CLI accepts --fix", () => {
  const root = createRoot();
  const source = join(root, "source.ts");
  writeFileSync(source, "export {};\n");

  const script = fileURLToPath(new URL("./check-spdx.ts", import.meta.url));
  const missing = spawnSync(process.execPath, ["--experimental-strip-types", script], {
    cwd: root,
    encoding: "utf8",
  });
  expect(missing.status).toBe(1);
  expect(`${missing.stdout}\n${missing.stderr}`).toContain("source.ts");

  const fixed = spawnSync(process.execPath, ["--experimental-strip-types", script, "--fix"], {
    cwd: root,
    encoding: "utf8",
  });

  expect(fixed.status).toBe(0);
  const passing = spawnSync(process.execPath, ["--experimental-strip-types", script], {
    cwd: root,
    encoding: "utf8",
  });
  expect(passing.status).toBe(0);
  expect(checkSpdx(root)).toEqual([]);
  expect(readFileSync(source, "utf8")).toBe("// SPDX-License-Identifier: Apache-2.0\nexport {};\n");
});
