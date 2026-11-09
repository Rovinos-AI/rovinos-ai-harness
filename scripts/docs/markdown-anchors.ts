// SPDX-License-Identifier: Apache-2.0
import { stripFencedMarkdown } from "./markdown.ts";

/**
 * Collects GitHub-style heading slugs and explicit HTML anchor IDs.
 *
 * @param markdown - Markdown source.
 * @returns Anchor IDs, including numeric suffixes for duplicate headings.
 */
export function collectHeadingIds(markdown: string): Set<string> {
  const text = stripFencedMarkdown(markdown);
  const ids = new Set<string>();
  const counts = new Map<string, number>();
  for (const line of text.split(/\r?\n/u)) {
    const heading = headingText(line);
    if (heading !== undefined) {
      const slug = slugify(heading);
      const count = counts.get(slug) ?? 0;
      ids.add(count === 0 ? slug : `${slug}-${String(count)}`);
      counts.set(slug, count + 1);
    }
    if (line.includes("<a") || line.includes("<span")) {
      for (const match of line.matchAll(/\bid\s*=\s*(?:"([^"]+)"|'([^']+)')/giu)) {
        ids.add(match[1] ?? match[2] ?? "");
      }
    }
  }
  return ids;
}

function headingText(line: string): string | undefined {
  const trimmed = line.trimStart();
  if (line.length - trimmed.length > 3 || !trimmed.startsWith("#")) {
    return undefined;
  }
  let markerLength = 0;
  while (trimmed[markerLength] === "#") {
    markerLength += 1;
  }
  if (
    markerLength === 0 ||
    markerLength > 6 ||
    (trimmed[markerLength] !== " " && trimmed[markerLength] !== "\t")
  ) {
    return undefined;
  }
  let heading = trimmed.slice(markerLength).trim();
  const closingHashes = /#+$/u.exec(heading)?.[0] ?? "";
  if (closingHashes.length > 0) {
    const beforeHashes = heading.slice(0, -closingHashes.length);
    if (beforeHashes.endsWith(" ") || beforeHashes.endsWith("\t")) {
      heading = beforeHashes.trimEnd();
    }
  }
  return heading;
}

function slugify(heading: string): string {
  return plainHeadingText(heading)
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replaceAll(/\s+/gu, "-");
}

function plainHeadingText(heading: string): string {
  let plain = "";
  let index = 0;
  while (index < heading.length) {
    if (heading[index] === "[") {
      const labelEnd = findClosingBracket(heading, index);
      if (labelEnd !== undefined && heading[labelEnd + 1] === "(") {
        const destinationEnd = findClosingParenthesis(heading, labelEnd + 1);
        if (destinationEnd !== undefined) {
          plain += heading.slice(index + 1, labelEnd);
          index = destinationEnd + 1;
          continue;
        }
      }
    }
    plain += heading.charAt(index);
    index += 1;
  }
  return plain;
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
