// SPDX-License-Identifier: Apache-2.0
import { JSDOM } from "jsdom";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type MermaidApi from "mermaid";
import { collectMarkdownSources, extractFencedBlocks, type MarkdownSource } from "./markdown.ts";

type Mermaid = typeof MermaidApi;
let mermaidPromise: Promise<Mermaid> | undefined;

/** One invalid Mermaid diagram. */
export interface MermaidIssue {
  readonly path: string;
  readonly line: number;
}

/**
 * Parses every fenced Mermaid diagram using Mermaid's Node API.
 *
 * @param sources - Markdown sources to inspect.
 * @returns Invalid diagrams in source order.
 */
export async function checkMermaid(sources: readonly MarkdownSource[]): Promise<MermaidIssue[]> {
  const issues: MermaidIssue[] = [];
  for (const source of sources) {
    for (const block of extractFencedBlocks(source.contents)) {
      if (block.language !== "mermaid") {
        continue;
      }
      try {
        const mermaid = await getMermaid();
        await mermaid.parse(block.contents);
      } catch {
        issues.push({ path: source.path, line: block.startLine });
      }
    }
  }
  return issues;
}

async function getMermaid(): Promise<Mermaid> {
  if (mermaidPromise !== undefined) {
    return mermaidPromise;
  }
  const dom = new JSDOM("");
  const hadWindow = Reflect.has(globalThis, "window");
  const previousWindow = Reflect.get(globalThis, "window");
  const hadDocument = Reflect.has(globalThis, "document");
  const previousDocument = Reflect.get(globalThis, "document");
  Reflect.set(globalThis, "window", dom.window);
  Reflect.set(globalThis, "document", dom.window.document);
  try {
    const imported = await import("mermaid");
    mermaidPromise = Promise.resolve(imported.default);
    return imported.default;
  } finally {
    if (hadWindow) {
      Reflect.set(globalThis, "window", previousWindow);
    } else {
      Reflect.deleteProperty(globalThis, "window");
    }
    if (hadDocument) {
      Reflect.set(globalThis, "document", previousDocument);
    } else {
      Reflect.deleteProperty(globalThis, "document");
    }
  }
}

async function runCheck(): Promise<void> {
  const rootDirectory = fileURLToPath(new URL("../../", import.meta.url));
  const issues = await checkMermaid(collectMarkdownSources(rootDirectory));
  for (const issue of issues) {
    process.stderr.write(`Error: invalid Mermaid diagram at ${issue.path}:${String(issue.line)}\n`);
  }
  if (issues.length > 0) {
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runCheck();
}
