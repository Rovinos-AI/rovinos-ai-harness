// SPDX-License-Identifier: Apache-2.0
import { readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDirectory = resolve(fileURLToPath(new URL("../", import.meta.url)));
const hadolintImage =
  "hadolint/hadolint:v2.14.0-debian@sha256:158cd0184dcaa18bd8ec20b61f4c1cabdf8b32a592d062f57bdcb8e4c1d312e2";
const editorconfigImage =
  "ghcr.io/editorconfig-checker/editorconfig-checker:4.0.2@sha256:2ba6232bfa0058f72f5f7d7816711590aa764afab1542af30b3ecb4553587918";
const ignoredDirectories = new Set([".git", ".tmp", "node_modules", "dist", "coverage"]);

function findFiles(directory: string, matches: (name: string) => boolean): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && !ignoredDirectories.has(entry.name)) {
      files.push(...findFiles(path, matches));
    } else if (entry.isFile() && matches(entry.name)) {
      files.push(relative(rootDirectory, path));
    }
  }

  return files.sort();
}

function run(command: string, args: string[], tool: string): boolean {
  const result = spawnSync(command, args, {
    cwd: rootDirectory,
    stdio: "inherit",
  });

  if (result.error !== undefined) {
    process.stderr.write(`Required ${tool} binary is unavailable.\n`);
    return false;
  }

  return result.status === 0;
}

function checkDockerfileDigests(files: string[]): boolean {
  let valid = true;

  for (const file of files) {
    const lines = readFileSync(resolve(rootDirectory, file), "utf8").split(/\r?\n/u);
    for (const [index, line] of lines.entries()) {
      const imageMatch = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)/iu.exec(line);
      const image = imageMatch?.[1];
      if (image === undefined || image === "scratch" || /@sha256:[\da-f]{64}$/iu.test(image)) {
        continue;
      }

      process.stderr.write(`${file}:${String(index + 1)}: FROM images must use a sha256 digest.\n`);
      valid = false;
    }
  }

  return valid;
}

function checkShellStrictMode(files: string[]): boolean {
  let valid = true;

  for (const file of files) {
    const lines = readFileSync(resolve(rootDirectory, file), "utf8").split(/\r?\n/u);
    const commandIndex = lines.findIndex(
      (line) =>
        !line.startsWith("#!") &&
        !line.startsWith("# SPDX-License-Identifier:") &&
        line.trim() !== "",
    );

    if (commandIndex < 0 || lines[commandIndex]?.trim() !== "set -euo pipefail") {
      process.stderr.write(
        `${file}:${String(commandIndex < 0 ? lines.length + 1 : commandIndex + 1)}: expected "set -euo pipefail" after the shell headers.\n`,
      );
      valid = false;
    }
  }

  return valid;
}

function containerSkipped(tool: string): boolean {
  if (process.env.LINT_SKIP_CONTAINERS !== "1") {
    return false;
  }

  process.stderr.write(`Warning: LINT_SKIP_CONTAINERS=1; skipping ${tool}.\n`);
  return true;
}

function lintShell(requestedFiles: string[], runner: typeof run): boolean {
  const shellFiles =
    requestedFiles.length > 0
      ? requestedFiles.map((file) => relative(rootDirectory, resolve(rootDirectory, file)))
      : findFiles(rootDirectory, (name) => name.endsWith(".sh"));
  return (
    checkShellStrictMode(shellFiles) &&
    (shellFiles.length === 0 ||
      runner("shellcheck", ["--severity=style", ...shellFiles], "ShellCheck"))
  );
}

function lintDocker(requestedFiles: string[], runner: typeof run, pullImages: boolean): boolean {
  const dockerFiles =
    requestedFiles.length > 0
      ? requestedFiles.map((file) => relative(rootDirectory, resolve(rootDirectory, file)))
      : findFiles(rootDirectory, (name) => name.startsWith("Dockerfile"));

  if (!checkDockerfileDigests(dockerFiles)) {
    return false;
  }
  if (dockerFiles.length === 0 || containerSkipped("hadolint")) {
    return true;
  }

  return runner(
    "docker",
    [
      "run",
      "--rm",
      pullImages ? "--pull=always" : "--pull=never",
      "--volume",
      `${rootDirectory}:/repo:ro`,
      "--workdir",
      "/repo",
      hadolintImage,
      "hadolint",
      "--config",
      ".hadolint.yaml",
      ...dockerFiles,
    ],
    "Docker for hadolint",
  );
}

function lintEditorconfig(
  requestedFiles: string[],
  runner: typeof run,
  pullImages: boolean,
): boolean {
  const directory = resolve(rootDirectory, requestedFiles[0] ?? ".");
  if (relative(rootDirectory, directory).startsWith("..")) {
    process.stderr.write("EditorConfig Checker paths must stay inside the repository.\n");
    return false;
  }
  if (containerSkipped("EditorConfig Checker")) {
    return true;
  }

  return runner(
    "docker",
    [
      "run",
      "--rm",
      pullImages ? "--pull=always" : "--pull=never",
      "--volume",
      `${directory}:/check:ro`,
      "--workdir",
      "/check",
      editorconfigImage,
    ],
    "Docker for EditorConfig Checker",
  );
}

/** Runs one extended lint mode with an injectable process runner. */
export function lint(
  mode: string,
  requestedFiles: string[],
  options: { runner?: typeof run; pullImages?: boolean } = {},
): boolean {
  const runner = options.runner ?? run;
  const pullImages = options.pullImages ?? process.env.LINT_PULL_IMAGES === "1";

  if (mode === "shell") {
    return lintShell(requestedFiles, runner);
  }

  if (mode === "docker") {
    return lintDocker(requestedFiles, runner, pullImages);
  }

  if (mode === "editorconfig") {
    return lintEditorconfig(requestedFiles, runner, pullImages);
  }

  process.stderr.write("Usage: lint-extended.ts <shell|docker|editorconfig> [Dockerfile ...]\n");
  return false;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = lint(process.argv[2] ?? "", process.argv.slice(3)) ? 0 : 1;
}
