// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { delimiter, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const rootDirectory = resolve(fileURLToPath(new URL("../", import.meta.url)));
const scriptPath = resolve(rootDirectory, "scripts/lint-extended.ts");
const markdownlintPath = resolve(rootDirectory, "node_modules/.bin/markdownlint-cli2");
const eslintPath = resolve(rootDirectory, "node_modules/.bin/eslint");
const cspellPath = resolve(rootDirectory, "node_modules/.bin/cspell");

function run(command: string, args: string[], input?: string, path = process.env.PATH ?? "") {
  return spawnSync(command, args, {
    cwd: rootDirectory,
    encoding: "utf8",
    env: { ...process.env, PATH: path },
    input,
    timeout: 120_000,
  });
}

function invokeLint(mode: string, args: string[] = [], path = process.env.PATH ?? "") {
  return (
    run(
      process.execPath,
      ["--experimental-strip-types", scriptPath, mode, ...args],
      undefined,
      path,
    ).status === 0
  );
}

function writeFixture(directory: string, name: string, contents: string): string {
  const file = resolve(directory, name);
  writeFileSync(file, contents);
  return file;
}

it("accepts clean Markdown and rejects untagged code fences", () => {
  const clean = run(
    markdownlintPath,
    ["--config", ".markdownlint-cli2.yaml", "-"],
    "# Guide\n\n<!-- test:run -->\n\n```text\nready\n```\n",
  );
  const invalid = run(
    markdownlintPath,
    ["--config", ".markdownlint-cli2.yaml", "-"],
    "# Guide\n\n```\nready\n```\n",
  );

  expect(clean.status).toBe(0);
  expect(invalid.status).not.toBe(0);
  expect(`${invalid.stdout}\n${invalid.stderr}`).toContain("MD040");
});

it("wires every extended linter into the static lint command", () => {
  const manifest = readFileSync(resolve(rootDirectory, "package.json"), "utf8");
  const pipeline = readFileSync(resolve(rootDirectory, "azure-pipelines.yml"), "utf8");

  for (const name of ["md", "yaml", "sh", "docker", "editorconfig", "spell"]) {
    expect(manifest).toContain(`"lint:${name}"`);
  }
  expect(manifest).toContain('"lint": "yarn lint:md && yarn lint:yaml');
  expect(pipeline).toContain("- script: yarn lint");
  expect(pipeline).not.toContain("LINT_SKIP_CONTAINERS");
});

it("accepts valid YAML and rejects duplicate keys through ESLint", () => {
  const clean = run(
    eslintPath,
    ["--stdin", "--stdin-filename", "lint-fixture.yml", "--max-warnings", "0"],
    "jobs:\n  build:\n    steps:\n      - script: yarn lint\n",
  );
  const invalid = run(
    eslintPath,
    ["--stdin", "--stdin-filename", "lint-fixture.yml", "--max-warnings", "0"],
    "name: first\nname: second\n",
  );

  expect(clean.status).toBe(0);
  expect(invalid.status).not.toBe(0);
}, 30_000);

it("accepts clean shell and rejects ShellCheck style violations", () => {
  const clean = run(
    "shellcheck",
    ["--severity=style", "--shell=bash", "-"],
    "#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s\\n' ready\n",
  );
  const invalid = run(
    "shellcheck",
    ["--severity=style", "--shell=bash", "-"],
    "#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s\\n' \"$(echo ready)\"\n",
  );

  expect(clean.status).toBe(0);
  expect(invalid.status).not.toBe(0);
});

it.skipIf(process.env.LINT_SKIP_CONTAINERS === "1")(
  "accepts a clean Dockerfile and rejects unpinned images and hadolint violations",
  () => {
    const temporaryRoot = mkdtempSync(resolve(rootDirectory, ".lint-docker-fixture-"));
    const imageDigest = "a".repeat(64);

    try {
      const clean = writeFixture(
        temporaryRoot,
        "Dockerfile.clean",
        `FROM node:22-slim@sha256:${imageDigest}\n`,
      );
      const invalid = writeFixture(
        temporaryRoot,
        "Dockerfile.invalid",
        `FROM node:22-slim@sha256:${imageDigest}\nRUN echo ready | cat\n`,
      );
      const unpinned = writeFixture(temporaryRoot, "Dockerfile.unpinned", "FROM node:22-slim\n");

      expect(invokeLint("docker", [relative(rootDirectory, clean)])).toBe(true);
      expect(invokeLint("docker", [relative(rootDirectory, invalid)])).toBe(false);
      expect(invokeLint("docker", [relative(rootDirectory, unpinned)])).toBe(false);
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.env.LINT_SKIP_CONTAINERS === "1")(
  "accepts EditorConfig-compliant files and rejects incorrect line endings",
  () => {
    const temporaryRoot = mkdtempSync(resolve(rootDirectory, ".lint-editorconfig-fixture-"));

    try {
      writeFixture(
        temporaryRoot,
        ".editorconfig",
        "root = true\n\n[*]\ncharset = utf-8\nend_of_line = lf\ninsert_final_newline = true\ntrim_trailing_whitespace = true\n",
      );
      writeFixture(temporaryRoot, "clean.txt", "clean\n");
      const clean = invokeLint("editorconfig", [relative(rootDirectory, temporaryRoot)]);
      writeFixture(temporaryRoot, "invalid.txt", "invalid\r\n");
      const invalid = invokeLint("editorconfig", [relative(rootDirectory, temporaryRoot)]);

      expect(clean).toBe(true);
      expect(invalid).toBe(false);
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  },
);

it("accepts project spelling and rejects an unknown word", () => {
  const temporaryRoot = mkdtempSync(resolve(rootDirectory, ".lint-spelling-fixture-"));

  try {
    const clean = writeFixture(temporaryRoot, "clean.md", "# A clear heading\n");
    const invalid = writeFixture(temporaryRoot, "invalid.md", "# A zxqplmword heading\n");

    expect(run(cspellPath, ["--config", "cspell.json", "--no-progress", clean]).status).toBe(0);
    expect(run(cspellPath, ["--config", "cspell.json", "--no-progress", invalid]).status).not.toBe(
      0,
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}, 30_000);

it("makes yarn lint fail when ShellCheck is unavailable", () => {
  const isolatedPath = mkdtempSync(join(tmpdir(), "harness-lint-path-"));
  const executableNames = new Set(["corepack", "yarn", "node"]);
  const locations = (process.env.PATH ?? "").split(delimiter);

  try {
    for (const name of executableNames) {
      const source = locations.map((location) => join(location, name)).find(existsSync);
      if (source !== undefined) {
        symlinkSync(source, join(isolatedPath, name));
      }
    }
    const corepackPath = resolve(isolatedPath, "corepack");
    expect(existsSync(corepackPath)).toBe(true);
    const result = spawnSync(corepackPath, ["yarn", "lint"], {
      cwd: rootDirectory,
      encoding: "utf8",
      env: { ...process.env, PATH: isolatedPath, LINT_SKIP_CONTAINERS: "1" },
      timeout: 120_000,
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("ShellCheck binary is unavailable");
  } finally {
    rmSync(isolatedPath, { recursive: true, force: true });
  }
}, 120_000);

it("rejects EditorConfig fixture paths outside the repository", () => {
  const outsideDirectory = mkdtempSync(join(tmpdir(), "harness-editorconfig-outside-"));
  const relativePath = relative(rootDirectory, outsideDirectory);

  try {
    expect(invokeLint("editorconfig", [relativePath], process.env.PATH ?? "")).toBe(false);
  } finally {
    rmSync(outsideDirectory, { recursive: true, force: true });
  }
});
