// SPDX-License-Identifier: Apache-2.0
import { existsSync, readdirSync } from "node:fs";
import { join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectMarkdownSources,
  extractFencedBlocks,
  type MarkdownSource,
} from "./markdown.ts";

/** One invalid link or heading reference in a Markdown document. */
export interface LinkIssue {
  readonly path: string;
  readonly line: number;
  readonly reason: string;
}

interface MarkdownLink {
  readonly destination: string;
  readonly line: number;
}

const skippedDirectories = new Set([".git", ".yarn", ".tmp", "coverage", "dist", "node_modules"]);
const inlineLinkPattern =
  /!?\[[^\]]*(?:\[[^\]]*\][^\]]*)*\]\(\s*(?:<([^>\n]+)>|((?:\\.|[^\s)])+))(?:\s+["'][^)\n]*["'])?\s*\)/gu;
const referenceDefinitionPattern = /^ {0,3}\[([^\]]+)\]:\s*(<[^>\n]+>|(?:\\.|[^\s]+))/gmu;
const referenceUsePattern = /!?\[([^\]]+)\]\[([^\]]*)\]/gu;
const htmlLinkPattern = /<(?:a|img)\b[^>]*?\b(?:href|src)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/giu;

/**
 * Checks relative Markdown links and GitHub-style heading anchors.
 *
 * @param sources - Markdown sources.
 * @param existingPaths - Repository-relative paths of existing files and directories.
 * @returns Link issues in source order.
 */
export function checkLinks(
  sources: readonly MarkdownSource[],
  existingPaths: ReadonlySet<string>,
): LinkIssue[] {
  const headingIds = new Map(
    sources.map((source) => [source.path, collectHeadingIds(source.contents)]),
  );
  const issues: LinkIssue[] = [];

  for (const source of sources) {
    for (const link of collectLinks(source.contents)) {
      const { destination, line } = link;
      if (destination.startsWith("/") || destination.startsWith("//")) {
        continue;
      }
      if (/^[A-Za-z][A-Za-z\d+.-]*:/u.test(destination)) {
        continue;
      }
      const hashIndex = destination.indexOf("#");
      const fragment = hashIndex < 0 ? "" : destination.slice(hashIndex + 1);
      const rawPath = (hashIndex < 0 ? destination : destination.slice(0, hashIndex)).split("?")[0] ?? "";
      let targetPath = source.path;
      if (rawPath.length > 0) {
        let decodedPath: string;
        try {
          decodedPath = decodeURIComponent(rawPath);
        } catch {
          issues.push({ path: source.path, line, reason: "invalid URL encoding in relative link" });
          continue;
        }
        targetPath = posix
          .normalize(posix.join(posix.dirname(source.path), decodedPath))
          .replace(/\/$/u, "");
      }
      if (!existingPaths.has(targetPath)) {
        issues.push({ path: source.path, line, reason: `unresolved relative link to ${targetPath}` });
        continue;
      }
      if (fragment.length > 0 && targetPath.toLowerCase().endsWith(".md")) {
        let decodedFragment: string;
        try {
          decodedFragment = decodeURIComponent(fragment);
        } catch {
          issues.push({ path: source.path, line, reason: "invalid URL encoding in anchor" });
          continue;
        }
        if (!headingIds.get(targetPath)?.has(decodedFragment)) {
          issues.push({ path: source.path, line, reason: `unresolved anchor in ${targetPath}` });
        }
      }
    }

    for (const reference of collectMissingReferences(source.contents)) {
      issues.push({
        path: source.path,
        line: reference.line,
        reason: `unresolved Markdown reference: ${reference.label}`,
      });
    }
  }
  return issues;
}

function stripFencedCode(markdown: string): string {
  const characters = markdown.split("");
  for (const block of extractFencedBlocks(markdown)) {
    for (let index = block.start; index < block.end; index += 1) {
      if (characters[index] !== "\n" && characters[index] !== "\r") {
        characters[index] = " ";
      }
    }
  }
  return characters.join("");
}

function stripCode(markdown: string): string {
  return stripFencedCode(markdown)
    .replace(/(`+)([^`\n]*?)\1/gu, (match) => " ".repeat(match.length));
}

function collectLinks(markdown: string): MarkdownLink[] {
  const text = stripCode(markdown);
  const links: MarkdownLink[] = [];
  for (const pattern of [inlineLinkPattern, htmlLinkPattern]) {
    for (const match of text.matchAll(pattern)) {
      const destination = (match[1] ?? match[2] ?? match[3] ?? "").replaceAll("\\", "");
      if (destination.length > 0) {
        links.push({
          destination: destination.replaceAll(/^<|>$/gu, ""),
          line: lineAt(text, match.index ?? 0),
        });
      }
    }
  }
  for (const match of text.matchAll(referenceDefinitionPattern)) {
    const destination = (match[2] ?? "").replaceAll(/^<|>$/gu, "").replaceAll("\\", "");
    if (destination.length > 0) {
      links.push({
        destination,
        line: lineAt(text, match.index ?? 0),
      });
    }
  }
  return links;
}

function collectMissingReferences(markdown: string): { label: string; line: number }[] {
  const text = stripCode(markdown);
  const definitions = new Set(
    [...text.matchAll(referenceDefinitionPattern)].map((match) =>
      normalizeReference(match[1] ?? ""),
    ),
  );
  return [...text.matchAll(referenceUsePattern)].flatMap((match) => {
    const label = normalizeReference(match[2] || match[1] || "");
    return definitions.has(label)
      ? []
      : [{ label, line: lineAt(text, match.index ?? 0) }];
  });
}

function normalizeReference(value: string): string {
  return value.trim().replaceAll(/\s+/gu, " ").toLowerCase();
}

function lineAt(text: string, offset: number): number {
  return text.slice(0, offset).split("\n").length;
}

function collectHeadingIds(markdown: string): Set<string> {
  const text = stripFencedCode(markdown);
  const ids = new Set<string>();
  const counts = new Map<string, number>();
  for (const line of text.split(/\r?\n/u)) {
    const heading = /^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/u.exec(line)?.[1];
    if (heading !== undefined) {
      const slug = slugify(heading);
      const count = counts.get(slug) ?? 0;
      ids.add(count === 0 ? slug : `${slug}-${String(count)}`);
      counts.set(slug, count + 1);
    }
    for (const match of line.matchAll(/<(?:a|span)\b[^>]*\bid\s*=\s*["']([^"']+)["']/giu)) {
      ids.add(match[1] ?? "");
    }
  }
  return ids;
}

function slugify(heading: string): string {
  const plain = heading
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/<[^>]*>/gu, "")
    .replace(/[`*_~]/gu, "");
  return plain
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/gu, "-");
}

async function checkExternalLinks(sources: readonly MarkdownSource[]): Promise<LinkIssue[]> {
  const unique = new Map<string, { path: string; line: number }>();
  for (const source of sources) {
    for (const { destination, line } of collectLinks(source.contents)) {
      if (/^https?:\/\//iu.test(destination) && !unique.has(destination)) {
        unique.set(destination, { path: source.path, line });
      }
    }
    for (const match of stripCode(source.contents).matchAll(/https?:\/\/[^\s<>()]+/giu)) {
      const destination = (match[0] ?? "").replace(/[.,!?;:]+$/u, "");
      if (destination.length > 0 && !unique.has(destination)) {
        unique.set(destination, {
          path: source.path,
          line: lineAt(source.contents, match.index ?? 0),
        });
      }
    }
  }
  const issues: LinkIssue[] = [];
  for (const [destination, location] of unique) {
    let url: URL;
    try {
      url = new URL(destination);
    } catch {
      issues.push({ ...location, reason: "invalid external HTTP URL" });
      continue;
    }
    if (
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.hostname === "localhost" ||
      url.hostname.endsWith(".localhost") ||
      url.hostname.endsWith(".local")
    ) {
      issues.push({ ...location, reason: "external URL host is not allowed" });
      continue;
    }
    try {
      const response = await fetch(url, {
        method: "HEAD",
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status < 200 || response.status >= 400) {
        issues.push({
          ...location,
          reason: `external HTTP link returned status ${String(response.status)}`,
        });
      }
    } catch {
      issues.push({ ...location, reason: "external HTTP link could not be reached" });
    }
  }
  return issues;
}

function collectExistingPaths(rootDirectory: string): Set<string> {
  const paths = new Set<string>(["."]);
  function collect(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = join(directory, entry.name);
      const path = relative(rootDirectory, absolutePath).split(sep).join("/");
      if (entry.isDirectory()) {
        paths.add(path);
        if (!skippedDirectories.has(entry.name)) {
          collect(absolutePath);
        }
      } else if (entry.isFile()) {
        paths.add(path);
      }
    }
  }
  collect(rootDirectory);
  return paths;
}

async function runCheck(): Promise<void> {
  const rootDirectory = fileURLToPath(new URL("../../", import.meta.url));
  const sources = collectMarkdownSources(rootDirectory);
  const issues = [
    ...checkLinks(sources, collectExistingPaths(rootDirectory)),
    ...(process.argv.includes("--external") ? await checkExternalLinks(sources) : []),
  ];
  for (const issue of issues) {
    process.stderr.write(`Error: ${issue.reason} at ${issue.path}:${String(issue.line)}\n`);
  }
  if (issues.length > 0) {
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runCheck();
}
