// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const scanScript = join(root, "scripts/security/secret-scan.sh");
const temporaryDirectories: string[] = [];

function createRepository(filePath: string): string {
  const directory = mkdtempSync(join(tmpdir(), "gitleaks-control-"));
  temporaryDirectories.push(directory);
  const git = (args: string[]) => {
    const result = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
    expect(result.status).toBe(0);
    return result;
  };

  git(["init", "--initial-branch=main"]);
  git(["config", "user.email", "secret-scan@example.test"]);
  git(["config", "user.name", "Secret Scan Test"]);
  copyFileSync(join(root, ".gitleaks.toml"), join(directory, ".gitleaks.toml"));
  writeFileSync(join(directory, "README.md"), "synthetic scanner test repository\n");
  git(["add", ".gitleaks.toml", "README.md"]);
  git(["commit", "-m", "baseline"]);
  git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
  git(["switch", "-c", "test-change"]);

  const file = join(directory, filePath);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, `synthetic AWS access key: ${["AKIA", "QWERTY9876543210"].join("")}\n`);
  git(["add", filePath]);
  git(["commit", "-m", "add scanner control"]);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("secret-scan.sh", () => {
  it("fails on a fake AWS key outside the fixture allowlist without printing it", () => {
    const repository = createRepository("secret.txt");
    const result = spawnSync("bash", [scanScript, "--source", repository], {
      encoding: "utf8",
    });
    const key = ["AKIA", "QWERTY9876543210"].join("");

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).not.toContain(key);
    expect(
      readFileSync(join(repository, "reports/security/gitleaks-report.json"), "utf8"),
    ).not.toContain(key);
  });

  it("allows fake keys in __fixtures__ paths", () => {
    const repository = createRepository("packages/example/__fixtures__/secret.txt");
    const result = spawnSync("bash", [scanScript, "--source", repository], {
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).not.toContain(["AKIA", "QWERTY9876543210"].join(""));
  });

  it("comments every narrow allowlist entry", () => {
    const config = readFileSync(join(root, ".gitleaks.toml"), "utf8");
    const allowlist = config.split("[allowlist]")[1]?.split("[[rules]]")[0] ?? "";
    const entries = allowlist.split(/\r?\n/u).filter((line) => /^\s*'''/u.test(line));
    const lines = allowlist.split(/\r?\n/u);

    expect(entries).toHaveLength(5);
    for (const entry of entries) {
      const index = lines.indexOf(entry);
      expect(lines[index - 1]?.trimStart()).toMatch(/^#/u);
    }
    expect(allowlist).toContain("(^|/)__fixtures__/");
    expect(allowlist).toContain("^examples/");
    expect(allowlist).toContain("example\\.test");
    expect(allowlist).toContain("FAKE_|test_");
    expect(allowlist).toContain("^akv://");
  });
});
