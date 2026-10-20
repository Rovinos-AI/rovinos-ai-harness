// SPDX-License-Identifier: Apache-2.0
// Capture comments use `<!-- capture:name=REGEX_WITH_(?<name>...) -->`; their named group
// supplies `<name>` placeholders to later blocks. Cleanup blocks run even after any failure.
import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

type BlockKind = "run" | "cleanup";

interface CaptureDirective {
  readonly name: string;
  readonly pattern: string;
}

/** One runnable or guaranteed-cleanup shell block extracted from Markdown. */
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
const fenceOpeningPattern = /^(`{3,}|~{3,})([\w-]+)(?:\s.*)?$/u;
const rootDirectory = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const excludedDirectories = new Set([".git", ".tmp", "coverage", "dist", "node_modules"]);

function validateCapture(capture: CaptureDirective): void {
  try {
    new RegExp(capture.pattern, "u");
  } catch {
    throw new DocTestError();
  }
  if (!/^[A-Za-z]\w*$/u.test(capture.name) || !capture.pattern.includes(`(?<${capture.name}>`)) {
    throw new DocTestError();
  }
}

function captureDirective(line: string): CaptureDirective | undefined {
  const prefix = "<!-- capture:";
  if (!line.startsWith(prefix) || !line.endsWith("-->")) {
    return undefined;
  }
  const content = line.slice(prefix.length, -3).trim();
  const separator = content.indexOf("=");
  if (separator < 0) {
    throw new DocTestError();
  }
  const capture = {
    name: content.slice(0, separator).trim(),
    pattern: content.slice(separator + 1).trim(),
  };
  validateCapture(capture);
  return capture;
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

interface FenceOptions {
  readonly lines: readonly string[];
  readonly start: number;
  readonly openingFence: string;
  readonly language: string | undefined;
  readonly kind: BlockKind | undefined;
  readonly captures: readonly CaptureDirective[];
}

function markedFence({ lines, start, openingFence, language, kind, captures }: FenceOptions): {
  readonly block?: DocTestBlock;
  readonly closingIndex: number;
} {
  if (kind !== undefined && language !== "bash" && language !== "sh" && language !== "shell") {
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
    ...(kind === undefined ? {} : { block: { kind, code: codeLines.join("\n"), captures } }),
    closingIndex,
  };
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
    const testMarker = testMarkerPattern.exec(trimmed)?.[1];
    if (testMarker !== undefined) {
      if (pendingKind !== undefined) {
        throw new DocTestError();
      }
      pendingKind = testMarker === "run" ? "run" : "cleanup";
      continue;
    }
    const capture = captureDirective(trimmed);
    if (capture !== undefined) {
      pendingCaptures.push(capture);
      continue;
    }
    if (trimmed.length === 0) {
      continue;
    }

    const fence = fenceOpeningPattern.exec(trimmed);
    if (fence === null) {
      pendingKind = undefined;
      pendingCaptures = [];
      continue;
    }
    const openingFence = fence[1] ?? "";
    const language = fence[2]?.toLowerCase();
    const kind = pendingKind;
    const captures = pendingCaptures;
    pendingKind = undefined;
    pendingCaptures = [];

    const parsedFence = markedFence({
      lines,
      start: index,
      openingFence,
      language,
      kind,
      captures,
    });
    index = parsedFence.closingIndex;
    if (parsedFence.block !== undefined) {
      blocks.push(parsedFence.block);
    }
  }

  if (blocks.every(({ kind }) => kind !== "run")) {
    throw new DocTestError();
  }
  return blocks;
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

function executeShellBlock(code: string, cwd: string, env: NodeJS.ProcessEnv): CommandResult {
  const result = spawnSync(
    "bash",
    ["--noprofile", "--norc", "-e", "-u", "-o", "pipefail", "-c", code],
    { cwd, env, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 20 * 60_000 },
  );
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
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

interface BlockExecutionContext {
  readonly captures: Map<string, string>;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly execute: BlockExecutor;
}

interface BlockExecutionOptions {
  readonly stopOnFailure: boolean;
  readonly priorFailure?: DocTestError | undefined;
}

function executeBlock(
  block: DocTestBlock,
  context: BlockExecutionContext,
): DocTestError | undefined {
  try {
    const result = context.execute(
      substituteCaptures(block.code, context.captures),
      context.cwd,
      context.env,
    );
    if (result.error !== undefined || result.status !== 0) {
      return new DocTestError(result.status ?? 1);
    }
    captureValues(block, result, context.captures);
    return undefined;
  } catch (error) {
    return error instanceof DocTestError ? error : new DocTestError();
  }
}

function executeBlocks(
  blocks: readonly DocTestBlock[],
  context: BlockExecutionContext,
  options: BlockExecutionOptions,
): DocTestError | undefined {
  let failure = options.priorFailure;
  for (const block of blocks) {
    const blockFailure = executeBlock(block, context);
    if (blockFailure !== undefined) {
      failure ??= blockFailure;
      if (options.stopOnFailure) {
        break;
      }
    }
  }
  return failure;
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
  const context = { captures, cwd: options.cwd, env, execute };
  const failure = executeBlocks(
    blocks.filter(({ kind }) => kind === "run"),
    context,
    { stopOnFailure: true },
  );
  const finalFailure = executeBlocks(
    blocks.filter(({ kind }) => kind === "cleanup"),
    context,
    { stopOnFailure: false, ...(failure === undefined ? {} : { priorFailure: failure }) },
  );

  if (finalFailure !== undefined) {
    throw finalFailure;
  }
}

function shouldCopyPath(path: string): boolean {
  const segments = path.split(sep);
  return (
    !segments.some((segment) => excludedDirectories.has(segment)) &&
    !segments.some(
      (segment) =>
        segment === ".env" || (segment.startsWith(".env.") && segment !== ".env.example"),
    )
  );
}

async function copyWorktree(workingDirectory: string): Promise<void> {
  const paths = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: rootDirectory, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
  )
    .split("\0")
    .filter((path) => path.length > 0 && shouldCopyPath(path));

  for (const path of paths) {
    const sourcePath = join(rootDirectory, path);
    const resolvedPath = await realpath(sourcePath).catch(() => {
      throw new DocTestError();
    });
    if (!resolvedPath.startsWith(`${rootDirectory}${sep}`)) {
      throw new DocTestError();
    }
    const sourceStats = await stat(resolvedPath);
    const destinationPath = join(workingDirectory, path);
    await mkdir(dirname(destinationPath), { recursive: true });
    await copyFile(resolvedPath, destinationPath);
    if ((sourceStats.mode & 0o111) !== 0) {
      await chmod(destinationPath, sourceStats.mode & 0o777);
    }
  }
}

/** Runs quickstart documentation blocks from a temporary copy of the repository. */
export async function runQuickstartDocTests(): Promise<void> {
  const markdown = await readFile(join(rootDirectory, "docs/quickstart.md"), "utf8");
  const temporaryRoot = await mkdtemp(join(rootDirectory, ".tmp/quickstart-doc-tests-"));
  const workingDirectory = join(temporaryRoot, "checkout");
  await mkdir(workingDirectory, { recursive: true });

  try {
    await copyWorktree(workingDirectory);
    executeDocTestBlocks(markdown, {
      cwd: workingDirectory,
      env: {
        ...process.env,
        HARNESS_IMAGE: "harness:local",
        COMPOSE_PROJECT_NAME: `harness-quickstart-${String(process.pid)}-${randomUUID()}`,
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
