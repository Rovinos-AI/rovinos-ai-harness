// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import dcoExemptions from "../config/dco-exemptions.json" with { type: "json" };
import { z } from "zod";

const recordSeparator = "\u001e";
const fieldSeparator = "\u001f";
const logFormat = `%H${fieldSeparator}%an${fieldSeparator}%ae${fieldSeparator}%B${recordSeparator}`;
const signedOffTrailer = /^Signed-off-by: .+ <([^<>@\s]+@[^<>\s]+)>$/gm;

/** Schema for the author names explicitly exempted from DCO sign-off checks. */
export const DcoExemptionsSchema = z.object({ exemptAuthors: z.array(z.string().min(1)) }).strict();

/** Validated DCO exemption policy. */
export type DcoExemptions = z.infer<typeof DcoExemptionsSchema>;

/** Commit fields used to evaluate DCO sign-off trailers. */
export interface DcoCommit {
  readonly sha: string;
  readonly authorName: string;
  readonly authorEmail: string;
  readonly message: string;
}

/** Sign-off failures and non-failing author-email warnings. */
export interface DcoResult {
  readonly missingSignOff: readonly string[];
  readonly authorEmailMismatch: readonly string[];
}

/**
 * Parses the machine-delimited commit records emitted by `git log`.
 *
 * @param output - Raw output from the DCO git-log format.
 * @returns Parsed commits.
 */
export function parseDcoLog(output: string): DcoCommit[] {
  return output
    .split(recordSeparator)
    .filter((record) => record.trim().length > 0)
    .map((rawRecord) => {
      const record = rawRecord.replace(/^\r?\n/, "");
      const shaEnd = record.indexOf(fieldSeparator);
      const nameEnd = record.indexOf(fieldSeparator, shaEnd + 1);
      const emailEnd = record.indexOf(fieldSeparator, nameEnd + 1);
      if (shaEnd <= 0 || nameEnd < 0 || emailEnd < 0) {
        throw new TypeError("Git returned an invalid DCO history record.");
      }
      return {
        sha: record.slice(0, shaEnd),
        authorName: record.slice(shaEnd + 1, nameEnd),
        authorEmail: record.slice(nameEnd + 1, emailEnd),
        message: record.slice(emailEnd + 1),
      };
    });
}

/**
 * Evaluates commit sign-offs while allowing only explicitly configured authors to be exempt.
 *
 * @param commits - Commits in the pull request range.
 * @param exemptions - Validated author exemptions.
 * @returns Missing sign-offs and non-failing author-email warnings.
 */
export function evaluateDco(commits: readonly DcoCommit[], exemptions: DcoExemptions): DcoResult {
  const exemptAuthors = new Set(exemptions.exemptAuthors);
  const missingSignOff: string[] = [];
  const authorEmailMismatch: string[] = [];

  for (const commit of commits) {
    if (exemptAuthors.has(commit.authorName)) {
      continue;
    }
    const trailers = [...commit.message.matchAll(signedOffTrailer)].map((match) => match[1]);
    const shortSha = commit.sha.slice(0, 7);
    if (trailers.length === 0) {
      missingSignOff.push(shortSha);
    } else if (
      !trailers.some((email) => email?.toLowerCase() === commit.authorEmail.toLowerCase())
    ) {
      authorEmailMismatch.push(shortSha);
    }
  }
  return { missingSignOff, authorEmailMismatch };
}

/**
 * Checks non-merge commits on the current branch against the remote PR target branch.
 *
 * @param repositoryRoot - Git working tree to inspect.
 * @param targetBranch - Azure target branch name or `refs/heads/` reference.
 * @param exemptions - Validated author exemptions.
 * @returns Missing sign-offs and non-failing author-email warnings.
 */
export function checkDco(
  repositoryRoot: string,
  targetBranch: string,
  exemptions: DcoExemptions,
): DcoResult {
  const branch = targetBranch.replace(/^refs\/heads\//, "");
  const validBranch = spawnSync("git", ["check-ref-format", "--branch", branch], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (validBranch.status !== 0) {
    throw new TypeError("The DCO target branch is invalid.");
  }

  const history = spawnSync(
    "git",
    ["log", "--no-merges", `--format=${logFormat}`, `origin/${branch}..HEAD`],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  if (history.status !== 0) {
    throw new TypeError("Could not read the DCO commit range.");
  }
  return evaluateDco(parseDcoLog(history.stdout), exemptions);
}

function runCheck(): void {
  const exemptions = DcoExemptionsSchema.parse(dcoExemptions);
  const targetBranch = process.env.TARGET_BRANCH;
  if (targetBranch === undefined || targetBranch.length === 0) {
    process.stderr.write("DCO check requires the PR target branch.\n");
    process.exitCode = 2;
    return;
  }

  let result: DcoResult;
  try {
    result = checkDco(process.cwd(), targetBranch, exemptions);
  } catch {
    process.stderr.write("DCO check could not read the PR commit range.\n");
    process.exitCode = 2;
    return;
  }

  if (result.authorEmailMismatch.length > 0) {
    process.stderr.write(
      `DCO warning: sign-off email differs from author email for ${result.authorEmailMismatch.join(", ")}.\n`,
    );
  }
  if (result.missingSignOff.length > 0) {
    process.stderr.write(
      `Commits missing a valid Signed-off-by trailer: ${result.missingSignOff.join(", ")}\n` +
        "Add sign-offs with: git rebase --signoff\n",
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCheck();
}
