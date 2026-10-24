// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJson } from "@rovinos/schemas";
import { z } from "zod";

const recordSeparator = "\u001e";
const fieldSeparator = "\u001f";
const historyFormat = `%H${fieldSeparator}%an${fieldSeparator}%ae${fieldSeparator}%cn${fieldSeparator}%ce${fieldSeparator}%B${recordSeparator}`;
const signatureFormat = `%H${fieldSeparator}%G?${fieldSeparator}%GF${fieldSeparator}%GP${recordSeparator}`;
const signedOffTrailer = /^Signed-off-by: .+ <([^<>@\s]+@[^<>\s]+)>$/gm;
const fingerprintSchema = z.string().regex(/^[A-F0-9]{40}$/);
const gpgUnavailableMessage =
  "GPG is required to verify a commit matching the configured DCO exemption, but gpg is not installed.";

/** Schema for exact, signature-verified identities exempted from DCO sign-off checks. */
export const DcoExemptionsSchema = z
  .object({
    exemptAuthors: z.array(
      z
        .object({
          authorName: z.string().min(1),
          authorEmail: z
            .email()
            .or(z.string().regex(/^\d+\+[\w-]+(?:\[bot\])?@users\.noreply\.github\.com$/)),
          committerName: z.string().min(1),
          committerEmail: z.email(),
          signingKeyFingerprints: z.array(fingerprintSchema).min(1),
        })
        .strict(),
    ),
  })
  .strict();

/** Validated DCO exemption policy. */
export type DcoExemptions = z.infer<typeof DcoExemptionsSchema>;

/** Commit fields used to evaluate DCO sign-off trailers. */
export interface DcoCommit {
  readonly sha: string;
  readonly authorName: string;
  readonly authorEmail: string;
  readonly committerName: string;
  readonly committerEmail: string;
  readonly signatureStatus: string;
  readonly signingKeyFingerprint: string;
  readonly primaryKeyFingerprint: string;
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
      const separators: number[] = [];
      let offset = 0;
      for (let index = 0; index < 5; index += 1) {
        offset = record.indexOf(fieldSeparator, offset);
        if (offset < 0) {
          throw new TypeError("Git returned an invalid DCO history record.");
        }
        separators.push(offset);
        offset += fieldSeparator.length;
      }
      const [shaEnd, authorNameEnd, authorEmailEnd, committerNameEnd, committerEmailEnd] =
        separators;
      if (
        shaEnd === undefined ||
        authorNameEnd === undefined ||
        authorEmailEnd === undefined ||
        committerNameEnd === undefined ||
        committerEmailEnd === undefined ||
        shaEnd <= 0
      ) {
        throw new TypeError("Git returned an invalid DCO history record.");
      }
      return {
        sha: record.slice(0, shaEnd),
        authorName: record.slice(shaEnd + 1, authorNameEnd),
        authorEmail: record.slice(authorNameEnd + 1, authorEmailEnd),
        committerName: record.slice(authorEmailEnd + 1, committerNameEnd),
        committerEmail: record.slice(committerNameEnd + 1, committerEmailEnd),
        signatureStatus: "",
        signingKeyFingerprint: "",
        primaryKeyFingerprint: "",
        message: record.slice(committerEmailEnd + 1),
      };
    });
}

function parseDcoSignatures(
  output: string,
): Map<
  string,
  Pick<DcoCommit, "signatureStatus" | "signingKeyFingerprint" | "primaryKeyFingerprint">
> {
  return new Map(
    output
      .split(recordSeparator)
      .filter((record) => record.trim().length > 0)
      .map((rawRecord) => {
        const record = rawRecord.replace(/^\r?\n/, "");
        const shaEnd = record.indexOf(fieldSeparator);
        const statusEnd = record.indexOf(fieldSeparator, shaEnd + 1);
        const signingFingerprintEnd = record.indexOf(fieldSeparator, statusEnd + 1);
        if (shaEnd <= 0 || statusEnd < 0 || signingFingerprintEnd < 0) {
          throw new TypeError("Git returned an invalid DCO signature record.");
        }
        return [
          record.slice(0, shaEnd),
          {
            signatureStatus: record.slice(shaEnd + 1, statusEnd),
            signingKeyFingerprint: record.slice(statusEnd + 1, signingFingerprintEnd),
            primaryKeyFingerprint: record.slice(signingFingerprintEnd + 1),
          },
        ];
      }),
  );
}

function isExemptionIdentity(commit: DcoCommit, exemptions: DcoExemptions): boolean {
  return exemptions.exemptAuthors.some(
    (author) =>
      commit.authorName === author.authorName &&
      commit.authorEmail === author.authorEmail &&
      commit.committerName === author.committerName &&
      commit.committerEmail === author.committerEmail,
  );
}

function createTrustedGpgHome(exemptions: DcoExemptions): string {
  const fingerprints = [
    ...new Set(exemptions.exemptAuthors.flatMap((author) => author.signingKeyFingerprints)),
  ];
  if (fingerprints.length === 0) {
    throw new TypeError("No trusted DCO signing-key fingerprints are configured.");
  }

  const gpgVersion = spawnSync("gpg", ["--version"], { encoding: "utf8" });
  if (gpgVersion.error !== undefined) {
    throw new TypeError(gpgUnavailableMessage);
  }
  if (gpgVersion.status !== 0) {
    throw new TypeError("Could not run gpg to verify the pinned DCO signing key.");
  }

  const home = mkdtempSync(join(tmpdir(), "check-dco-gpg-"));
  try {
    const keyPath = fileURLToPath(new URL("../config/web-flow.gpg", import.meta.url));
    const imported = spawnSync("gpg", ["--batch", "--homedir", home, "--import", keyPath], {
      encoding: "utf8",
    });
    if (imported.status !== 0) {
      throw new TypeError("Could not import the pinned DCO signing key.");
    }

    const listed = spawnSync(
      "gpg",
      ["--batch", "--homedir", home, "--with-colons", "--fingerprint", "--list-keys"],
      { encoding: "utf8" },
    );
    if (listed.status !== 0) {
      throw new TypeError("Could not inspect the pinned DCO signing key.");
    }
    const importedFingerprints = new Set(
      listed.stdout
        .split("\n")
        .filter((line) => line.startsWith("fpr:"))
        .map((line) => line.split(":")[9] ?? ""),
    );
    if (!fingerprints.every((fingerprint) => importedFingerprints.has(fingerprint))) {
      throw new TypeError("The DCO signing-key fingerprint is not present in the pinned key.");
    }

    const trust = fingerprints.map((fingerprint) => `${fingerprint}:6:`).join("\n");
    const trusted = spawnSync("gpg", ["--batch", "--homedir", home, "--import-ownertrust"], {
      encoding: "utf8",
      input: `${trust}\n`,
    });
    if (trusted.status !== 0) {
      throw new TypeError("Could not trust the pinned DCO signing key.");
    }
    return home;
  } catch (error) {
    rmSync(home, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Evaluates commit sign-offs, exempting only exact identities with a trusted web-flow signature.
 *
 * @param commits - Commits in the pull request range.
 * @param exemptions - Validated author exemptions.
 * @returns Missing sign-offs and non-failing author-email warnings.
 */
export function evaluateDco(commits: readonly DcoCommit[], exemptions: DcoExemptions): DcoResult {
  const missingSignOff: string[] = [];
  const authorEmailMismatch: string[] = [];

  for (const commit of commits) {
    const exempt = exemptions.exemptAuthors.some(
      (author) =>
        commit.authorName === author.authorName &&
        commit.authorEmail === author.authorEmail &&
        commit.committerName === author.committerName &&
        commit.committerEmail === author.committerEmail &&
        commit.signatureStatus === "G" &&
        (author.signingKeyFingerprints.includes(commit.signingKeyFingerprint) ||
          author.signingKeyFingerprints.includes(commit.primaryKeyFingerprint)),
    );
    if (exempt) {
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
    ["log", "--no-merges", `--format=${historyFormat}`, `origin/${branch}..HEAD`],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
    },
  );
  if (history.status !== 0) {
    throw new TypeError("Could not read the DCO commit range.");
  }
  const commits = parseDcoLog(history.stdout);
  const commitsToVerify = commits.filter((commit) => isExemptionIdentity(commit, exemptions));
  if (commitsToVerify.length === 0) {
    return evaluateDco(commits, exemptions);
  }

  const gpgHome = createTrustedGpgHome(exemptions);
  try {
    const signatures = spawnSync(
      "git",
      ["log", "--no-walk", `--format=${signatureFormat}`, ...commitsToVerify.map(({ sha }) => sha)],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: { ...process.env, GNUPGHOME: gpgHome },
      },
    );
    if (signatures.status !== 0) {
      throw new TypeError("Could not verify DCO commit signatures.");
    }
    const signaturesBySha = parseDcoSignatures(signatures.stdout);
    const verifiedCommits = commits.map((commit) => ({
      ...commit,
      ...signaturesBySha.get(commit.sha),
    }));
    return evaluateDco(verifiedCommits, exemptions);
  } finally {
    rmSync(gpgHome, { recursive: true, force: true });
  }
}

function runCheck(): void {
  const exemptions = parseJson(
    DcoExemptionsSchema,
    readFileSync(fileURLToPath(new URL("../config/dco-exemptions.json", import.meta.url)), "utf8"),
  );
  const targetBranch = process.env.TARGET_BRANCH;
  if (targetBranch === undefined || targetBranch.length === 0) {
    process.stderr.write("DCO check requires the PR target branch.\n");
    process.exitCode = 2;
    return;
  }

  let result: DcoResult;
  try {
    result = checkDco(process.cwd(), targetBranch, exemptions);
  } catch (error) {
    if (error instanceof Error && error.message === gpgUnavailableMessage) {
      process.stderr.write(`${gpgUnavailableMessage}\n`);
      process.exitCode = 2;
      return;
    }
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
        `Add sign-offs with: git rebase --signoff origin/${targetBranch.replace(/^refs\/heads\//, "")} && git push --force-with-lease\n`,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCheck();
}
