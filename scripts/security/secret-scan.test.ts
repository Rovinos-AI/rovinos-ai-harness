// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJson } from "@rovinos/schemas";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const scanScript = join(root, "scripts/security/secret-scan.sh");
const temporaryDirectories: string[] = [];

function createRepository(
  filePath: string,
  key = ["AK", "IA", "QWERTY9876543210"].join(""),
): string {
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
  writeFileSync(file, `synthetic AWS access key: ${key}\n`);
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
    const key = ["AK", "IA", "QWERTY9876543210"].join("");

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
    expect(`${result.stdout}${result.stderr}`).not.toContain(
      ["AK", "IA", "QWERTY9876543210"].join(""),
    );
  });

  it("does not allow a fake marker embedded after a key-shaped value", () => {
    const syntheticValue = ["AK", "IA", "QWERTY9876543210", "-test_", "marker9876543210"].join("");
    const repository = createRepository("secret.txt", syntheticValue);
    const result = spawnSync("bash", [scanScript, "--source", repository], {
      encoding: "utf8",
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).not.toContain(syntheticValue);
    expect(
      readFileSync(join(repository, "reports/security/gitleaks-report.json"), "utf8"),
    ).not.toContain(syntheticValue);
  });

  it("allows a synthetic value that starts with FAKE_", () => {
    const syntheticValue = ["FAKE_", "AK", "IA", "QWERTY9876543210"].join("");
    const repository = createRepository("synthetic.txt", syntheticValue);
    const result = spawnSync("bash", [scanScript, "--source", repository], {
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).not.toContain(syntheticValue);
  });

  it("suppresses only the acknowledged commit for a pinned ignore fingerprint", () => {
    const key = ["AK", "IA", "QWERTY9876543210"].join("");
    const repository = createRepository("secret.txt");
    const scan = () =>
      spawnSync("bash", [scanScript, "--nightly", "--source", repository], { encoding: "utf8" });
    const git = (args: string[]) => {
      const result = spawnSync("git", args, { cwd: repository, encoding: "utf8" });
      expect(result.status).toBe(0);
      return result.stdout.trim();
    };
    const reportPath = join(repository, "reports/security/gitleaks-report.json");

    expect(scan().status).not.toBe(0);
    const findings = parseJson(
      z.array(z.object({ Fingerprint: z.string().min(1) }).loose()),
      readFileSync(reportPath, "utf8"),
    );
    expect(findings).toHaveLength(1);
    const fingerprint = findings[0]?.Fingerprint ?? "";
    expect(fingerprint.startsWith(`${git(["rev-parse", "HEAD"])}:secret.txt:`)).toBe(true);

    writeFileSync(
      join(repository, ".gitleaksignore"),
      `# Synthetic control acknowledged for this one commit.\n${fingerprint}\n`,
    );
    git(["add", ".gitleaksignore"]);
    git(["commit", "-m", "acknowledge synthetic control"]);
    expect(scan().status).toBe(0);

    writeFileSync(join(repository, "again.txt"), `synthetic AWS access key: ${key}\n`);
    git(["add", "again.txt"]);
    git(["commit", "-m", "add the same synthetic key again"]);
    const repeated = scan();
    expect(repeated.status).not.toBe(0);
    expect(`${repeated.stdout}${repeated.stderr}`).not.toContain(key);
    expect(readFileSync(reportPath, "utf8")).not.toContain(key);
  });

  it("pins and comments every repository ignore fingerprint", () => {
    const lines = readFileSync(join(root, ".gitleaksignore"), "utf8").split(/\r?\n/u);
    const entries = lines.filter((line) => line.trim() !== "" && !line.startsWith("#"));

    expect(entries).toHaveLength(7);
    for (const entry of entries) {
      expect(entry).toMatch(/^[0-9a-f]{40}:[^:\s]+:[a-z0-9-]+:[1-9]\d*$/u);
      expect(lines[lines.indexOf(entry) - 1]).toMatch(/^# \S/u);
    }
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
    expect(allowlist).toContain("^(FAKE_|test_)");
    expect(allowlist).toContain("^akv://");
  });
});
