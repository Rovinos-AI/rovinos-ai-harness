// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import {
  checkDco,
  DcoExemptionsSchema,
  evaluateDco,
  parseDcoLog,
  type DcoExemptions,
} from "./check-dco.js";

const temporaryDirectories: string[] = [];
const noExemptions = DcoExemptionsSchema.parse({ exemptAuthors: [] });

function runGit(repository: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
  const result = spawnSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) {
    throw new TypeError("Git fixture setup failed.");
  }
  return result.stdout.trim();
}

function createRepository(): string {
  const repository = mkdtempSync(join(tmpdir(), "check-dco-"));
  temporaryDirectories.push(repository);
  runGit(repository, ["init", "--quiet", "--initial-branch=main"]);
  runGit(repository, ["config", "user.name", "Test Author"]);
  runGit(repository, ["config", "user.email", "author@example.test"]);
  writeFileSync(join(repository, "base.txt"), "base\n");
  runGit(repository, ["add", "base.txt"]);
  runGit(repository, [
    "-c",
    "user.name=Test Author",
    "-c",
    "user.email=author@example.test",
    "commit",
    "--quiet",
    "-m",
    "base",
  ]);
  runGit(repository, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  runGit(repository, ["checkout", "--quiet", "-b", "feature"]);
  return repository;
}

function commit(
  repository: string,
  path: string,
  content: string,
  message: string,
  author: { readonly name: string; readonly email: string } = {
    name: "Test Author",
    email: "author@example.test",
  },
): string {
  writeFileSync(join(repository, path), content);
  runGit(repository, ["add", path]);
  runGit(repository, [
    "-c",
    `user.name=${author.name}`,
    "-c",
    `user.email=${author.email}`,
    "commit",
    "--quiet",
    "-m",
    message,
  ]);
  return runGit(repository, ["rev-parse", "HEAD"]);
}

function runDcoCli(repository: string): {
  readonly status: number | null;
  readonly output: string;
} {
  const script = fileURLToPath(new URL("./check-dco.ts", import.meta.url));
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", script],
    {
      cwd: repository,
      encoding: "utf8",
      env: { ...process.env, TARGET_BRANCH: "refs/heads/main" },
    },
  );
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("accepts a commit with a valid sign-off trailer", () => {
  const repository = createRepository();
  commit(
    repository,
    "signed.txt",
    "signed\n",
    "signed change\n\nSigned-off-by: Test Author <author@example.test>",
  );

  expect(checkDco(repository, "main", noExemptions)).toEqual({
    missingSignOff: [],
    authorEmailMismatch: [],
  });
});

it("reports an unsigned commit and gives the sign-off repair command", () => {
  const repository = createRepository();
  const sha = commit(repository, "unsigned.txt", "unsigned\n", "unsigned change");
  const result = checkDco(repository, "main", noExemptions);
  const cli = runDcoCli(repository);

  expect(result.missingSignOff).toEqual([sha.slice(0, 7)]);
  expect(result.authorEmailMismatch).toEqual([]);
  expect(cli.status).toBe(1);
  expect(cli.output).toContain(sha.slice(0, 7));
  expect(cli.output).toContain("git rebase --signoff");
});

it("ignores unsigned merge commits", () => {
  const repository = createRepository();
  commit(
    repository,
    "feature.txt",
    "feature\n",
    "feature change\n\nSigned-off-by: Test Author <author@example.test>",
  );
  runGit(repository, ["checkout", "--quiet", "main"]);
  runGit(repository, ["checkout", "--quiet", "-b", "other"]);
  commit(
    repository,
    "other.txt",
    "other\n",
    "other change\n\nSigned-off-by: Test Author <author@example.test>",
  );
  runGit(repository, ["checkout", "--quiet", "feature"]);
  runGit(repository, ["merge", "--no-ff", "--quiet", "other", "-m", "unsigned merge"]);

  expect(checkDco(repository, "main", noExemptions).missingSignOff).toEqual([]);
});

it("rejects malformed sign-off trailers", () => {
  const repository = createRepository();
  const sha = commit(
    repository,
    "malformed.txt",
    "malformed\n",
    "malformed change\n\nSigned-off-by: Test Author <invalid-email>",
  );

  expect(checkDco(repository, "main", noExemptions).missingSignOff).toEqual([sha.slice(0, 7)]);
});

it("exempts configured bot authors and still rejects other unsigned authors", () => {
  const repository = createRepository();
  commit(repository, "bot.txt", "bot\n", "bot change", {
    name: "copilot-swe-agent[bot]",
    email: "bot@example.test",
  });
  const authorSha = commit(repository, "author.txt", "author\n", "author change");
  const exemptions: DcoExemptions = DcoExemptionsSchema.parse({
    exemptAuthors: ["copilot-swe-agent[bot]"],
  });

  expect(evaluateDco(parseDcoLog(""), exemptions)).toEqual({
    missingSignOff: [],
    authorEmailMismatch: [],
  });
  expect(checkDco(repository, "main", exemptions).missingSignOff).toEqual([authorSha.slice(0, 7)]);
});

it("warns without failing when the valid trailer uses a different email", () => {
  const repository = createRepository();
  const sha = commit(
    repository,
    "different-email.txt",
    "content\n",
    "change\n\nSigned-off-by: Another Author <other@example.test>",
  );

  expect(checkDco(repository, "main", noExemptions)).toEqual({
    missingSignOff: [],
    authorEmailMismatch: [sha.slice(0, 7)],
  });
});

it("rejects malformed git history output", () => {
  expect(() => parseDcoLog("invalid record")).toThrow("invalid DCO history record");
});
