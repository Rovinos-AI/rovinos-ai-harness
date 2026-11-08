// SPDX-License-Identifier: Apache-2.0
import { readdirSync } from "node:fs";
import { join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { collectHeadingIds } from "./markdown-anchors.ts";
import { collectMarkdownSources, stripMarkdownCode, type MarkdownSource } from "./markdown.ts";

/** One invalid link or heading reference in a Markdown document. */
export interface LinkIssue {
  readonly path: string;
  readonly line: number;
  readonly reason: string;
}

/** One link destination extracted from Markdown. */
export interface MarkdownLink {
  readonly destination: string;
  readonly line: number;
}

const skippedDirectories = new Set([".git", ".yarn", ".tmp", "coverage", "dist", "node_modules"]);
const referenceDefinitionPattern = /^ {0,3}\[([^\]\n]+)\]:\s*(<\S+>|\S+)/gmu;
const htmlLinkPattern = /\b(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/giu;

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
  return sources.flatMap((source) => [
    ...collectMarkdownLinks(source.contents).flatMap((link) => {
      const issue = checkRelativeLink(source, link, existingPaths, headingIds);
      return issue === undefined ? [] : [issue];
    }),
    ...collectMissingReferences(source.contents).map((reference) => ({
      path: source.path,
      line: reference.line,
      reason: `unresolved Markdown reference: ${reference.label}`,
    })),
  ]);
}

function checkRelativeLink(
  source: MarkdownSource,
  link: MarkdownLink,
  existingPaths: ReadonlySet<string>,
  headingIds: ReadonlyMap<string, Set<string>>,
): LinkIssue | undefined {
  const { destination, line } = link;
  if (
    destination.startsWith("/") ||
    destination.startsWith("//") ||
    /^[A-Za-z][A-Za-z\d+.-]*:/u.test(destination)
  ) {
    return undefined;
  }
  const hashIndex = destination.indexOf("#");
  const fragment = hashIndex < 0 ? "" : destination.slice(hashIndex + 1);
  const rawPath =
    (hashIndex < 0 ? destination : destination.slice(0, hashIndex)).split("?")[0] ?? "";
  let targetPath = source.path;
  if (rawPath.length > 0) {
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(rawPath);
    } catch {
      return { path: source.path, line, reason: "invalid URL encoding in relative link" };
    }
    targetPath = posix
      .normalize(posix.join(posix.dirname(source.path), decodedPath))
      .replaceAll(/\/$/gu, "");
  }
  if (!existingPaths.has(targetPath)) {
    return { path: source.path, line, reason: `unresolved relative link to ${targetPath}` };
  }
  if (fragment.length === 0 || !targetPath.toLowerCase().endsWith(".md")) {
    return undefined;
  }
  let decodedFragment: string;
  try {
    decodedFragment = decodeURIComponent(fragment);
  } catch {
    return { path: source.path, line, reason: "invalid URL encoding in anchor" };
  }
  return headingIds.get(targetPath)?.has(decodedFragment) === true
    ? undefined
    : { path: source.path, line, reason: `unresolved anchor in ${targetPath}` };
}

/**
 * Extracts inline, reference, HTML, and autolink destinations from Markdown.
 *
 * @param markdown - Markdown source.
 * @returns Link destinations and their source lines.
 */
export function collectMarkdownLinks(markdown: string): MarkdownLink[] {
  const text = stripMarkdownCode(markdown);
  return [
    ...collectInlineLinks(text),
    ...collectHtmlLinks(text),
    ...collectReferenceLinks(text),
    ...collectAutoLinks(text),
  ];
}

function collectInlineLinks(text: string): MarkdownLink[] {
  const links: MarkdownLink[] = [];
  let index = 0;
  while (index < text.length) {
    if (text[index] !== "[") {
      index += 1;
      continue;
    }
    const labelEnd = findClosingBracket(text, index);
    if (labelEnd === undefined || text[labelEnd + 1] !== "(") {
      index += 1;
      continue;
    }
    const destination = parseLinkDestination(text, labelEnd + 1);
    if (destination !== undefined && destination.value.length > 0) {
      links.push({ destination: destination.value, line: lineAt(text, index) });
      index = destination.end + 1;
    } else {
      index += 1;
    }
  }
  return links;
}

function collectHtmlLinks(text: string): MarkdownLink[] {
  const links: MarkdownLink[] = [];
  for (const match of text.matchAll(htmlLinkPattern)) {
    const destination = match[1] ?? match[2] ?? match[3];
    if (destination !== undefined && destination.length > 0) {
      links.push({
        destination: destination.replaceAll(/[>"']$/gu, ""),
        line: lineAt(text, match.index),
      });
    }
  }
  return links;
}

function collectReferenceLinks(text: string): MarkdownLink[] {
  const links: MarkdownLink[] = [];
  for (const match of text.matchAll(referenceDefinitionPattern)) {
    const destination = match[2].replaceAll(/^<|>$/gu, "");
    if (destination.length > 0) {
      links.push({
        destination,
        line: lineAt(text, match.index),
      });
    }
  }
  return links;
}

function collectAutoLinks(text: string): MarkdownLink[] {
  const links: MarkdownLink[] = [];
  for (const match of text.matchAll(/https?:\/\/\S+/giu)) {
    const destination = match[0].replaceAll(/[.,!?;:)>]+$/gu, "");
    if (destination.length > 0) {
      links.push({ destination, line: lineAt(text, match.index) });
    }
  }
  return links;
}

function findClosingBracket(text: string, openingIndex: number): number | undefined {
  let depth = 0;
  for (let index = openingIndex; index < text.length; index += 1) {
    const character = text[index];
    if (character === "\\") {
      index += 1;
    } else if (character === "[") {
      depth += 1;
    } else if (character === "]") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return undefined;
}

function parseLinkDestination(
  text: string,
  openingIndex: number,
): { readonly value: string; readonly end: number } | undefined {
  const end = findClosingParenthesis(text, openingIndex);
  if (end === undefined) {
    return undefined;
  }
  const start = skipWhitespace(text, openingIndex + 1, end);
  const value =
    text[start] === "<"
      ? angleDestination(text, start, end)
      : unquotedDestination(text, start, end);
  return value === undefined ? undefined : { value, end };
}

function skipWhitespace(text: string, start: number, end: number): number {
  let index = start;
  while (index < end && /\s/u.test(text.charAt(index))) {
    index += 1;
  }
  return index;
}

function angleDestination(text: string, start: number, end: number): string | undefined {
  const angleEnd = text.indexOf(">", start + 1);
  return angleEnd < 0 || angleEnd > end
    ? undefined
    : unescapeLinkDestination(text.slice(start + 1, angleEnd));
}

function unquotedDestination(text: string, start: number, end: number): string {
  return unescapeLinkDestination(text.slice(start, unquotedDestinationEnd(text, start, end)));
}

function unquotedDestinationEnd(text: string, start: number, end: number): number {
  let depth = 0;
  let index = start;
  while (index < end) {
    const character = text.charAt(index);
    if (character === "\\") {
      index += 2;
      continue;
    }
    if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      if (depth === 0) {
        break;
      }
      depth -= 1;
    } else if (/\s/u.test(character) && depth === 0) {
      break;
    }
    index += 1;
  }
  return index;
}

function findClosingParenthesis(text: string, openingIndex: number): number | undefined {
  let depth = 0;
  let quote = "";
  for (let index = openingIndex; index < text.length; index += 1) {
    const character = text[index];
    if (character === "\\") {
      index += 1;
    } else if (quote.length > 0) {
      if (character === quote) {
        quote = "";
      }
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return undefined;
}

function unescapeLinkDestination(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "\\" && index + 1 < value.length) {
      index += 1;
    }
    result += value.charAt(index);
  }
  return result;
}

function collectMissingReferences(markdown: string): { label: string; line: number }[] {
  const text = stripMarkdownCode(markdown);
  const definitions = new Set(
    [...text.matchAll(referenceDefinitionPattern)].map((match) =>
      normalizeReference(match[1] ?? ""),
    ),
  );
  const missing: { label: string; line: number }[] = [];
  let index = 0;
  while (index < text.length) {
    if (text[index] !== "[") {
      index += 1;
      continue;
    }
    const labelEnd = findClosingBracket(text, index);
    if (labelEnd === undefined || text[labelEnd + 1] !== "[") {
      index += 1;
      continue;
    }
    const referenceEnd = findClosingBracket(text, labelEnd + 1);
    if (referenceEnd === undefined) {
      index += 1;
      continue;
    }
    const reference = text.slice(labelEnd + 2, referenceEnd);
    const labelText = reference.length > 0 ? reference : text.slice(index + 1, labelEnd);
    const label = normalizeReference(labelText);
    if (!definitions.has(label)) {
      missing.push({ label, line: lineAt(text, index) });
    }
    index = referenceEnd + 1;
  }
  return missing;
}

function normalizeReference(value: string): string {
  return value.trim().replaceAll(/\s+/gu, " ").toLowerCase();
}

function lineAt(text: string, offset: number): number {
  return text.slice(0, offset).split("\n").length;
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
  const externalIssues = process.argv.includes("--external")
    ? await import("./check-external-links.ts").then(({ checkExternalLinks }) =>
        checkExternalLinks(sources),
      )
    : [];
  const issues = [...checkLinks(sources, collectExistingPaths(rootDirectory)), ...externalIssues];
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
