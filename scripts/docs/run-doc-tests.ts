// SPDX-License-Identifier: Apache-2.0
// Cleanup blocks run even after any failure.
import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DocTestError, extractDocTestBlocks, substituteCaptures } from "./doc-blocks.js";
import type { DocTestBlock } from "./doc-blocks.js";

interface CommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error | undefined;
}

type BlockExecutor = (code: string, cwd: string, env: NodeJS.ProcessEnv) => CommandResult;

const rootDirectory = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const excludedDirectories = new Set([".git", ".tmp", "coverage", "dist", "node_modules"]);

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
  readonly prelude: string;
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
    const code = substituteCaptures(block.code, context.captures);
    const executionCode = context.prelude.length === 0 ? code : `${context.prelude}\n${code}`;
    const result = context.execute(executionCode, context.cwd, context.env);
    if (result.error !== undefined || result.status !== (block.expectedExitCode ?? 0)) {
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
  const prelude = blocks.find(({ kind }) => kind === "prelude")?.code ?? "";
  const context = { captures, cwd: options.cwd, env, execute, prelude };
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

/** Creates the temporary checkout parent even when it does not already exist. */
export async function createDocTestTemporaryRoot(parentDirectory: string): Promise<string> {
  await mkdir(parentDirectory, { recursive: true });
  return mkdtemp(join(parentDirectory, "quickstart-doc-tests-"));
}

async function runDocTestFiles(
  markdownPaths: readonly string[],
  projectName: string,
): Promise<void> {
  const markdownFiles = await Promise.all(
    markdownPaths.map((path) => readFile(join(rootDirectory, path), "utf8")),
  );
  const temporaryRoot = await createDocTestTemporaryRoot(join(rootDirectory, ".tmp"));
  const workingDirectory = join(temporaryRoot, "checkout");
  await mkdir(workingDirectory, { recursive: true });

  try {
    await copyWorktree(workingDirectory);
    for (const markdown of markdownFiles) {
      executeDocTestBlocks(markdown, {
        cwd: workingDirectory,
        env: {
          ...process.env,
          HARNESS_IMAGE: "harness:local",
          HARNESS_SANDBOX_IMAGE: "harness-sandbox:local",
          COMPOSE_PROJECT_NAME: `harness-${projectName}-${String(process.pid)}-${randomUUID()}`,
        },
      });
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

/** Runs the documented quickstart blocks from a temporary repository copy. */
export async function runQuickstartDocTests(): Promise<void> {
  await runDocTestFiles(["docs/quickstart.md"], "quickstart");
}

/** Runs every copy-paste example README from one temporary repository copy. */
export async function runExampleDocTests(): Promise<void> {
  await runDocTestFiles(
    [
      "examples/basic-agent/README.md",
      "examples/approval/README.md",
      "examples/crash-and-resume/README.md",
    ],
    "examples",
  );
}

/** Runs the documented replay example command from the current worktree. */
export async function runReplayExampleDocTests(): Promise<void> {
  const markdown = await readFile(join(rootDirectory, "examples/replay/README.md"), "utf8");
  executeDocTestBlocks(markdown, { cwd: rootDirectory, env: process.env });
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
