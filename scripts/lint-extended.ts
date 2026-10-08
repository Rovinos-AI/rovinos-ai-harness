// SPDX-License-Identifier: Apache-2.0
import { readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDirectory = resolve(fileURLToPath(new URL("../", import.meta.url)));
const hadolintImage =
  "hadolint/hadolint:v2.14.0-debian@sha256:bb143dee5ef4a59958be7d6315c15ce2a239c7fd6c362f66888aabca123a8059";
const editorconfigImage =
  "ghcr.io/editorconfig-checker/editorconfig-checker:4.0.2@sha256:f997cfb58a878832c587e9e02aa3ba3eb984b7ea7a074f5523df40271fa4e637";
const ignoredDirectories = new Set([".git", "node_modules", "dist", "coverage"]);

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

function containerSkipped(tool: string): boolean {
  if (process.env.LINT_SKIP_CONTAINERS !== "1") {
    return false;
  }

  process.stderr.write(`Warning: LINT_SKIP_CONTAINERS=1; skipping ${tool}.\n`);
  return true;
}

function lint(mode: string, requestedFiles: string[]): boolean {
  if (mode === "shell") {
    const shellFiles = findFiles(rootDirectory, (name) => name.endsWith(".sh"));
    return (
      shellFiles.length === 0 ||
      run("shellcheck", ["--severity=style", ...shellFiles], "ShellCheck")
    );
  }

  if (mode === "docker") {
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

    return run(
      "docker",
      [
        "run",
        "--rm",
        "--pull=always",
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

  if (mode === "editorconfig") {
    const directory = resolve(rootDirectory, requestedFiles[0] ?? ".");
    if (relative(rootDirectory, directory).startsWith("..")) {
      process.stderr.write("EditorConfig Checker paths must stay inside the repository.\n");
      return false;
    }
    if (containerSkipped("EditorConfig Checker")) {
      return true;
    }

    return run(
      "docker",
      [
        "run",
        "--rm",
        "--pull=always",
        "--volume",
        `${directory}:/check:ro`,
        "--workdir",
        "/check",
        editorconfigImage,
      ],
      "Docker for EditorConfig Checker",
    );
  }

  process.stderr.write("Usage: lint-extended.ts <shell|docker|editorconfig> [Dockerfile ...]\n");
  return false;
}

process.exitCode = lint(process.argv[2] ?? "", process.argv.slice(3)) ? 0 : 1;
