// SPDX-License-Identifier: Apache-2.0
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

interface MarkdownSource {
  readonly path: string;
  readonly contents: string;
}

interface BannedClaim {
  readonly phrase: string;
  readonly pattern: RegExp;
}

/** One banned claim found in a Markdown source. */
export interface ClaimViolation {
  readonly path: string;
  readonly line: number;
  readonly phrase: string;
}

const bannedClaims: readonly BannedClaim[] = [
  { phrase: "completely secure", pattern: /\bcompletely secure\b/iu },
  { phrase: "100% safe", pattern: /\b100% safe\b/iu },
  { phrase: "impossible to leak", pattern: /\bimpossible to leak\b/iu },
  { phrase: "guaranteed compliant", pattern: /\bguaranteed compliant\b/iu },
  { phrase: "never leaks", pattern: /\bnever leaks\b/iu },
  { phrase: "cannot leak", pattern: /\bcannot leak\b/iu },
];
const allowMarker = /<!--\s*claims:allow\s*-->/u;

/**
 * Finds Markdown files in the README and docs tree without following symlinks.
 *
 * @param rootDirectory - Repository root.
 * @returns Repository-relative Markdown sources.
 */
export function collectMarkdownSources(rootDirectory: string): MarkdownSource[] {
  const sources: MarkdownSource[] = [
    {
      path: "README.md",
      contents: readFileSync(join(rootDirectory, "README.md"), "utf8"),
    },
  ];

  function collectDirectory(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        collectDirectory(path);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        sources.push({
          path: relative(rootDirectory, path).split(sep).join("/"),
          contents: readFileSync(path, "utf8"),
        });
      }
    }
  }

  const docsDirectory = join(rootDirectory, "docs");
  if (existsSync(docsDirectory)) {
    collectDirectory(docsDirectory);
  }
  return sources.sort((left, right) => left.path.localeCompare(right.path));
}

/**
 * Finds banned absolute claims unless their line has the explicit allow marker.
 *
 * @param sources - Markdown sources to inspect.
 * @returns Violations containing paths and line numbers.
 */
export function findClaimViolations(sources: readonly MarkdownSource[]): ClaimViolation[] {
  const violations: ClaimViolation[] = [];
  for (const source of sources) {
    const lines = source.contents.split(/\r?\n/u);
    for (const [index, line] of lines.entries()) {
      if (allowMarker.test(line)) {
        continue;
      }
      for (const claim of bannedClaims) {
        if (claim.pattern.test(line)) {
          violations.push({ path: source.path, line: index + 1, phrase: claim.phrase });
        }
      }
    }
  }
  return violations;
}

function runClaimLint(): void {
  const rootDirectory = fileURLToPath(new URL("../../", import.meta.url));
  const violations = findClaimViolations(collectMarkdownSources(rootDirectory));
  for (const violation of violations) {
    process.stderr.write(
      `Error: banned absolute claim "${violation.phrase}" at ${violation.path}:${String(violation.line)}\n`,
    );
  }
  if (violations.length > 0) {
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runClaimLint();
}
