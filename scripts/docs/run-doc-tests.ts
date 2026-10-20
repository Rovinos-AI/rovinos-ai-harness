// SPDX-License-Identifier: Apache-2.0
// Capture comments use `<!-- capture:name=REGEX_WITH_(?<name>...) -->`; their named group
// supplies `<name>` placeholders to later blocks. Cleanup blocks run even after any failure.
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

type BlockKind = "run" | "cleanup";

interface CaptureDirective {
  readonly name: string;
  readonly pattern: string;
}

export interface DocTestBlock {
  readonly kind: BlockKind;
  readonly code: string;
  readonly captures: readonly CaptureDirective[];
}

interface CommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error | undefined;
}

type BlockExecutor = (code: string, cwd: string, env: NodeJS.ProcessEnv) => CommandResult;

class DocTestError extends Error {
  readonly code = "docs_quickstart_test_failed";
  readonly exitCode: number;

  constructor(exitCode = 1) {
    super("docs_quickstart_test_failed");
    this.name = "DocTestError";
    this.exitCode = exitCode === 0 ? 1 : exitCode;
  }
}

const testMarkerPattern = /^<!--\s*test:(run|cleanup)\s*-->$/u;
const captureMarkerPattern = /^<!--\s*capture:([A-Za-z][A-Za-z0-9]*)=(.*?)\s*-->$/u;
const rootDirectory = fileURLToPath(new URL("../../", import.meta.url));
const excludedDirectories = new Set([".git", ".tmp", "coverage", "dist", "node_modules"]);

function validateCapture(capture: CaptureDirective): void {
  try {
    new RegExp(capture.pattern, "u");
  } catch {
    throw new DocTestError();
  }
  if (!capture.pattern.includes(`(?<${capture.name}>`)) {
    throw new DocTestError();
  }
}

/** Extracts marked shell blocks and capture comments from a Markdown document. */
export function extractDocTestBlocks(markdown: string): DocTestBlock[] {
  const lines = markdown.split(/\r?\n/u);
  const blocks: DocTestBlock[] = [];
  let pendingKind: BlockKind | undefined;
  let pendingCaptures: CaptureDirective[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    const testMarker = testMarkerPattern.exec(trimmed);
    if (testMarker !== null) {
      if (pendingKind !== undefined) {
        throw new DocTestError();
      }
      const markerKind = testMarker[1];
      if (markerKind !== "run" && markerKind !== "cleanup") {
        throw new DocTestError();
      }
      pendingKind = markerKind;
      continue;
    }
    const captureMarker = captureMarkerPattern.exec(trimmed);
    if (captureMarker !== null) {
      const name = captureMarker[1];
      const pattern = captureMarker[2]?.trim();
      if (name === undefined || pattern === undefined || pattern.length === 0) {
        throw new DocTestError();
      }
      const capture = { name, pattern };
      validateCapture(capture);
      pendingCaptures.push(capture);
      continue;
    }
    if (trimmed.length === 0) {
      continue;
    }

    const fence = /^(`{3,}|~{3,})([A-Za-z0-9_-]+)(?:\s.*)?$/u.exec(trimmed);
    if (fence === null) {
      pendingKind = undefined;
      pendingCaptures = [];
      continue;
    }
    const openingFence = fence[1];
    if (openingFence === undefined) {
      throw new DocTestError();
    }
    const language = fence[2]?.toLowerCase();
    const kind = pendingKind;
    const captures = pendingCaptures;
    pendingKind = undefined;
    pendingCaptures = [];

    const closingFencePattern = new RegExp(`^${openingFence[0]}{${openingFence.length},}\\s*$`, "u");
    const codeLines: string[] = [];
    let closingIndex = index + 1;
    while (closingIndex < lines.length && !closingFencePattern.test(lines[closingIndex]?.trim() ?? "")) {
      codeLines.push(lines[closingIndex] ?? "");
      closingIndex += 1;
    }
    if (closingIndex >= lines.length) {
      if (kind !== undefined) {
        throw new DocTestError();
      }
      break;
    }
    index = closingIndex;
    if (kind !== undefined) {
      if (language !== "bash" && language !== "sh" && language !== "shell") {
        throw new DocTestError();
      }
      blocks.push({ kind, code: codeLines.join("\n"), captures });
    }
  }

  if (blocks.every(({ kind }) => kind !== "run")) {
    throw new DocTestError();
  }
  return blocks;
}

/** Replaces each `<name>` placeholder with a value captured by an earlier block. */
export function substituteCaptures(
  code: string,
  captures: ReadonlyMap<string, string>,
): string {
  return code.replace(/<([A-Za-z][A-Za-z0-9]*)>/gu, (_placeholder, name: string) => {
    const value = captures.get(name);
    if (value === undefined) {
      throw new DocTestError();
    }
    return value;
  });
}

function executeShellBlock(code: string, cwd: string, env: NodeJS.ProcessEnv): CommandResult {
  const result = spawnSync(
    "bash",
    ["--noprofile", "--norc", "-e", "-u", "-o", "pipefail", "-c", code],
    { cwd, env, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 20 * 60_000 },
  );
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ...(result.error === undefined ? {} : { error: result.error }),
  };
}

function captureValues(
  block: DocTestBlock,
  result: CommandResult,
  captures: Map<string, string>,
): void {
  const output = `${result.stdout}\n${result.stderr}`;
  for (const directive of block.captures) {
    const match = new RegExp(directive.pattern, "u").exec(output);
    const value = match?.groups?.[directive.name];
    if (value === undefined) {
      throw new DocTestError();
    }
    captures.set(directive.name, value);
  }
}

/** Executes marked blocks sequentially and attempts every cleanup block after failures. */
export function executeDocTestBlocks(
  markdown: string,
  options: {
    readonly cwd: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly execute?: BlockExecutor;
  },
): void {
  const blocks = extractDocTestBlocks(markdown);
  const captures = new Map<string, string>();
  const env = options.env ?? process.env;
  const execute = options.execute ?? executeShellBlock;
  let failure: DocTestError | undefined;

  for (const block of blocks.filter(({ kind }) => kind === "run")) {
    try {
      const result = execute(substituteCaptures(block.code, captures), options.cwd, env);
      if (result.error !== undefined || result.status !== 0) {
        throw new DocTestError(result.status ?? 1);
      }
      captureValues(block, result, captures);
    } catch (error) {
      failure = error instanceof DocTestError ? error : new DocTestError();
      break;
    }
  }

  for (const block of blocks.filter(({ kind }) => kind === "cleanup")) {
    try {
      const result = execute(substituteCaptures(block.code, captures), options.cwd, env);
      if ((result.error !== undefined || result.status !== 0) && failure === undefined) {
        failure = new DocTestError(result.status ?? 1);
      }
    } catch (error) {
      if (failure === undefined) {
        failure = error instanceof DocTestError ? error : new DocTestError();
      }
    }
  }

  if (failure !== undefined) {
    throw failure;
  }
}

function shouldCopyPath(path: string): boolean {
  const segments = relative(rootDirectory, path).split(sep);
  return !segments.some((segment) => excludedDirectories.has(segment)) &&
    !segments.some((segment) => segment === ".env" || (segment.startsWith(".env.") && segment !== ".env.example"));
}

/** Runs quickstart documentation blocks from a temporary copy of the repository. */
export async function runQuickstartDocTests(): Promise<void> {
  const markdown = await readFile(join(rootDirectory, "docs/quickstart.md"), "utf8");
  const temporaryRoot = await mkdtemp(join(rootDirectory, ".tmp/quickstart-doc-tests-"));
  const workingDirectory = join(temporaryRoot, "checkout");
  await mkdir(workingDirectory, { recursive: true });

  try {
    await cp(rootDirectory, workingDirectory, {
      recursive: true,
      filter: (source) => shouldCopyPath(resolve(source)),
    });
    executeDocTestBlocks(markdown, {
      cwd: workingDirectory,
      env: {
        ...process.env,
        HARNESS_IMAGE: "harness:local",
        COMPOSE_PROJECT_NAME: `harness-quickstart-${process.pid}-${randomUUID()}`,
      },
    });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runQuickstartDocTests().then(
    () => process.stdout.write("quickstart documentation passed\n"),
    (error: unknown) => {
      const code = error instanceof DocTestError ? error.code : "docs_quickstart_test_failed";
      process.stderr.write(`${code}\n`);
      process.exitCode = 1;
    },
  );
}
