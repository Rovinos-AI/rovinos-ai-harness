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
    const opening = /^ {0,3}(?<fence>`{3,}|~{3,})(?<info>.*?)(?:\r?\n)?$/u.exec(line);
    if (opening?.groups === undefined) {
      offset += line.length;
      continue;
    }
    const fence = opening.groups.fence ?? "";
    const language = (opening.groups.info ?? "").trim().split(/\s+/u, 1)[0]?.toLowerCase() ?? "";
    const start = offset;
    const startLine = index + 1;
    const contentLines: string[] = [];
    offset += line.length;
    let closed = false;
    while (index + 1 < lines.length) {
      index += 1;
      const contentLine = lines[index] ?? "";
      const closing = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*(?:\\r?\\n)?$`, "u");
      offset += contentLine.length;
      if (closing.test(contentLine)) {
        closed = true;
        break;
      }
      contentLines.push(contentLine);
    }
    if (closed) {
      blocks.push({
        language,
        contents: contentLines.join("").replace(/\r?\n$/u, ""),
        start,
        end: offset,
        startLine,
      });
    }
  }
  return blocks;
}
