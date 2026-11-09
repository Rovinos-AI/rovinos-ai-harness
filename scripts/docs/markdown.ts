// SPDX-License-Identifier: Apache-2.0
import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

const skippedDirectories = new Set([".git", ".yarn", ".tmp", "coverage", "dist", "node_modules"]);

/** One Markdown file discovered beneath a repository root. */
export interface MarkdownSource {
  readonly path: string;
  readonly contents: string;
}

/** One fenced code block with its source offsets and opening line. */
export interface FencedBlock {
  readonly language: string;
  readonly contents: string;
  readonly start: number;
  readonly end: number;
  readonly startLine: number;
}

/**
 * Collects Markdown files under a repository root without following symlinks or dependency trees.
 *
 * @param rootDirectory - Repository root.
 * @returns Markdown sources in stable path order.
 */
export function collectMarkdownSources(rootDirectory: string): MarkdownSource[] {
  const sources: MarkdownSource[] = [];

  function collect(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && !skippedDirectories.has(entry.name)) {
        collect(resolve(directory, entry.name));
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        const absolutePath = resolve(directory, entry.name);
        sources.push({
          path: relative(rootDirectory, absolutePath).split(sep).join("/"),
          contents: readFileSync(absolutePath, "utf8"),
        });
      }
    }
  }

  collect(rootDirectory);
  return sources.sort((left, right) => left.path.localeCompare(right.path));
}

/**
 * Extracts fenced code blocks, including the character offsets of each complete fence.
 *
 * @param markdown - Markdown source.
 * @returns Fenced blocks in source order.
 */
export function extractFencedBlocks(markdown: string): FencedBlock[] {
  const blocks: FencedBlock[] = [];
  const lines = markdown.match(/.*(?:\r?\n|$)/gu) ?? [];
  let offset = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const opening = parseFenceOpening(line);
    if (opening === undefined) {
      offset += line.length;
      continue;
    }
    const start = offset;
    const startLine = index + 1;
    const contentLines: string[] = [];
    offset += line.length;
    let closed = false;
    while (index + 1 < lines.length) {
      index += 1;
      const contentLine = lines[index] ?? "";
      offset += contentLine.length;
      if (isClosingFence(contentLine, opening.character, opening.length)) {
        closed = true;
        break;
      }
      contentLines.push(contentLine);
    }
    if (closed) {
      blocks.push({
        language: opening.language,
        contents: contentLines.join("").replace(/\r?\n$/u, ""),
        start,
        end: offset,
        startLine,
      });
    }
  }
  return blocks;
}

function parseFenceOpening(
  line: string,
): { readonly character: string; readonly length: number; readonly language: string } | undefined {
  const contents = line.endsWith("\n") ? line.slice(0, -1) : line;
  let indentation = 0;
  while (contents[indentation] === " " && indentation <= 3) {
    indentation += 1;
  }
  if (indentation > 3) {
    return undefined;
  }
  const indented = contents.slice(indentation);
  const character = indented[0] ?? "";
  if (character !== "`" && character !== "~") {
    return undefined;
  }
  let length = 0;
  while (indented[length] === character) {
    length += 1;
  }
  if (length < 3) {
    return undefined;
  }
  const info = indented.slice(length).trim();
  return {
    character,
    length,
    language: (info.split(/\s+/u, 1)[0] ?? "").toLowerCase(),
  };
}

function isClosingFence(line: string, character: string, minimumLength: number): boolean {
  const withoutLineEnding = line.endsWith("\n") ? line.slice(0, -1) : line;
  let indentation = 0;
  while (withoutLineEnding[indentation] === " " && indentation <= 3) {
    indentation += 1;
  }
  if (indentation > 3) {
    return false;
  }
  const contents = withoutLineEnding.slice(indentation).trimEnd();
  let length = 0;
  while (contents[length] === character) {
    length += 1;
  }
  return length >= minimumLength && contents.slice(length).trim().length === 0;
}

/** Replaces fenced code with spaces while preserving line positions and source offsets. */
export function stripFencedMarkdown(markdown: string): string {
  const characters = Array.from({ length: markdown.length }, (_, index) => markdown.charAt(index));
  for (const block of extractFencedBlocks(markdown)) {
    for (let index = block.start; index < block.end; index += 1) {
      if (characters[index] !== "\n" && characters[index] !== "\r") {
        characters[index] = " ";
      }
    }
  }
  return characters.join("");
}

/** Replaces fenced and inline code with spaces while preserving source positions. */
export function stripMarkdownCode(markdown: string): string {
  const text = stripFencedMarkdown(markdown);
  const characters = Array.from({ length: text.length }, (_, index) => text.charAt(index));
  let index = 0;
  while (index < text.length) {
    if (text[index] !== "`") {
      index += 1;
      continue;
    }
    const openingLength = countTicks(text, index);
    const closing = findClosingTicks(text, index + openingLength, openingLength);
    if (closing === undefined) {
      index += openingLength;
      continue;
    }
    for (
      let characterIndex = index;
      characterIndex < closing + openingLength;
      characterIndex += 1
    ) {
      if (characters[characterIndex] !== "\n" && characters[characterIndex] !== "\r") {
        characters[characterIndex] = " ";
      }
    }
    index = closing + openingLength;
  }
  return characters.join("");
}

function countTicks(text: string, start: number): number {
  let length = 0;
  while (text[start + length] === "`") {
    length += 1;
  }
  return length;
}

function findClosingTicks(text: string, start: number, length: number): number | undefined {
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === "\n" || text[index] === "\r") {
      return undefined;
    }
    if (text[index] === "`" && countTicks(text, index) === length) {
      return index;
    }
  }
  return undefined;
}
