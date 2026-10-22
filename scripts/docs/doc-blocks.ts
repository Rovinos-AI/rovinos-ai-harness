// SPDX-License-Identifier: Apache-2.0
/** Capture comments use `<!-- capture:name=REGEX_WITH_(?<name>...) -->`. */
type BlockKind = "run" | "cleanup" | "prelude";

interface CaptureDirective {
  readonly name: string;
  readonly pattern: string;
}

/** One runnable or guaranteed-cleanup shell block extracted from Markdown. */
export interface DocTestBlock {
  readonly kind: BlockKind;
  readonly code: string;
  readonly captures: readonly CaptureDirective[];
  readonly expectedExitCode?: number;
}

/** Safe error raised when a documentation test directive is invalid or fails. */
export class DocTestError extends Error {
  readonly code = "docs_quickstart_test_failed";
  readonly exitCode: number;

  constructor(exitCode = 1) {
    super("docs_quickstart_test_failed");
    this.name = "DocTestError";
    this.exitCode = exitCode === 0 ? 1 : exitCode;
  }
}

interface FenceOptions {
  readonly lines: readonly string[];
  readonly start: number;
  readonly openingFence: string;
  readonly language: string | undefined;
  readonly kind: BlockKind | undefined;
  readonly captures: readonly CaptureDirective[];
  readonly expectedExitCode: number | undefined;
}

interface ParsedFence {
  readonly block?: DocTestBlock;
  readonly closingIndex: number;
}

const testMarkerPattern = /^<!--\s*test:(run|cleanup|prelude)\s*-->$/u;
const expectedExitCodePattern = /^<!--\s*test:expect-exit=(\d+)\s*-->$/u;
const fenceOpeningPattern = /^(`{3,}|~{3,})([\w-]+)(?:\s.*)?$/u;
const capturePattern = /^(?<name>[A-Za-z]\w*)=(?<pattern>[\s\S]+)$/u;

function captureDirective(line: string): CaptureDirective | undefined {
  const prefix = "<!-- capture:";
  if (!line.startsWith(prefix) || !line.endsWith("-->")) {
    return undefined;
  }
  const match = capturePattern.exec(line.slice(prefix.length, -3).trim());
  const name = match?.groups?.name;
  const pattern = match?.groups?.pattern?.trim();
  if (name === undefined || pattern === undefined) {
    throw new DocTestError();
  }
  if (!pattern.includes(`(?<${name}>`)) {
    throw new DocTestError();
  }
  try {
    new RegExp(pattern, "u");
  } catch {
    throw new DocTestError();
  }
  return { name, pattern };
}

function isClosingFence(line: string, openingFence: string): boolean {
  const trimmed = line.trim();
  const character = openingFence.charAt(0);
  return (
    trimmed.length >= openingFence.length &&
    trimmed.startsWith(character.repeat(openingFence.length)) &&
    trimmed.replaceAll(character, "").length === 0
  );
}

function blockKindFromMarker(marker: string): BlockKind {
  switch (marker) {
    case "run":
      return "run";
    case "prelude":
      return "prelude";
    default:
      return "cleanup";
  }
}

function markedFence(options: FenceOptions): ParsedFence {
  const { lines, start, openingFence, language, kind, captures, expectedExitCode } = options;
  if (kind !== undefined && language !== "bash" && language !== "sh" && language !== "shell") {
    throw new DocTestError();
  }
  if (expectedExitCode !== undefined && kind !== "run") {
    throw new DocTestError();
  }
  const codeLines: string[] = [];
  let closingIndex = start + 1;
  while (closingIndex < lines.length && !isClosingFence(lines[closingIndex] ?? "", openingFence)) {
    codeLines.push(lines[closingIndex] ?? "");
    closingIndex += 1;
  }
  if (closingIndex >= lines.length) {
    if (kind !== undefined) {
      throw new DocTestError();
    }
    return { closingIndex };
  }
  return {
    ...(kind === undefined
      ? {}
      : {
          block: {
            kind,
            code: codeLines.join("\n"),
            captures,
            ...(expectedExitCode === undefined ? {} : { expectedExitCode }),
          },
        }),
    closingIndex,
  };
}

class DocBlockParser {
  readonly #lines: readonly string[];
  readonly #blocks: DocTestBlock[] = [];
  #pendingKind: BlockKind | undefined;
  #pendingCaptures: CaptureDirective[] = [];
  #pendingExpectedExitCode: number | undefined;

  constructor(markdown: string) {
    this.#lines = markdown.split(/\r?\n/u);
  }

  parse(): DocTestBlock[] {
    for (let index = 0; index < this.#lines.length; index += 1) {
      const line = (this.#lines[index] ?? "").trim();
      if (this.#consumeDirective(line)) {
        continue;
      }
      const fence = fenceOpeningPattern.exec(line);
      if (fence === null) {
        this.#resetPendingDirectives();
        continue;
      }
      const parsedFence = this.#parseFence(index, fence);
      index = parsedFence.closingIndex;
      if (parsedFence.block !== undefined) {
        this.#blocks.push(parsedFence.block);
      }
    }
    this.#validateBlocks();
    return this.#blocks;
  }

  #consumeDirective(line: string): boolean {
    const marker = testMarkerPattern.exec(line)?.[1];
    if (marker !== undefined) {
      if (this.#pendingKind !== undefined) {
        throw new DocTestError();
      }
      this.#pendingKind = blockKindFromMarker(marker);
      return true;
    }
    const expectedExitMatch = expectedExitCodePattern.exec(line);
    if (expectedExitMatch !== null) {
      const expectedExitCode = Number(expectedExitMatch[1]);
      if (
        this.#pendingExpectedExitCode !== undefined ||
        !Number.isSafeInteger(expectedExitCode) ||
        expectedExitCode > 255
      ) {
        throw new DocTestError();
      }
      this.#pendingExpectedExitCode = expectedExitCode;
      return true;
    }
    if (line.startsWith("<!-- test:expect-exit=")) {
      throw new DocTestError();
    }
    const capture = captureDirective(line);
    if (capture !== undefined) {
      this.#pendingCaptures.push(capture);
      return true;
    }
    return line.length === 0;
  }

  #parseFence(index: number, fence: RegExpExecArray): ParsedFence {
    const [kind, captures, expectedExitCode] = [
      this.#pendingKind,
      this.#pendingCaptures,
      this.#pendingExpectedExitCode,
    ];
    this.#resetPendingDirectives();
    return markedFence({
      lines: this.#lines,
      start: index,
      openingFence: fence[1] ?? "",
      language: fence[2]?.toLowerCase(),
      kind,
      captures,
      expectedExitCode,
    });
  }

  #resetPendingDirectives(): void {
    this.#pendingKind = undefined;
    this.#pendingCaptures = [];
    this.#pendingExpectedExitCode = undefined;
  }

  #validateBlocks(): void {
    if (
      this.#blocks.every(({ kind }) => kind !== "run") ||
      this.#blocks.filter(({ kind }) => kind === "prelude").length > 1
    ) {
      throw new DocTestError();
    }
  }
}

/** Extracts marked shell blocks and capture comments from a Markdown document. */
export function extractDocTestBlocks(markdown: string): DocTestBlock[] {
  return new DocBlockParser(markdown).parse();
}

/** Replaces each `<name>` placeholder with a value captured by an earlier block. */
export function substituteCaptures(code: string, captures: ReadonlyMap<string, string>): string {
  return code.replaceAll(/<([A-Za-z]\w*)>/gu, (_placeholder, name: string) => {
    const value = captures.get(name);
    if (value === undefined) {
      throw new DocTestError();
    }
    return value;
  });
}
