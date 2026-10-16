// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { HarnessError, type Id } from "@harness/schemas";
import { ensureRunWorkspace, resolveWorkspacePath } from "./workspace.js";
import {
  MAX_FS_READ_BYTES,
  MAX_FS_WRITE_BYTES,
  FsEditInputSchema,
  FsListInputSchema,
  FsReadInputSchema,
  FsSearchInputSchema,
  FsWriteInputSchema,
} from "./fs-tools.js";
import type {
  FsEditInput,
  FsOperationErrorCode,
  FsListEntry,
  FsListInput,
  FsOperation,
  FsReadInput,
  FsSearchInput,
  FsToolResult,
  FsWriteInput,
} from "./fs-tools.js";

const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const DEFAULT_RUN_QUOTA_BYTES = 500 * 1024 * 1024;
const MAX_SEARCH_LINE_CHARS = 2048;
const NOFOLLOW = constants.O_NOFOLLOW;
const NON_BLOCKING = constants.O_NONBLOCK;
const EMPTY_SHA256 = createHash("sha256").update(new Uint8Array()).digest("hex");

/** Raised when a workspace file operation is invalid or cannot be completed safely. */
export class WorkspaceFileError extends HarnessError {
  readonly code: FsOperationErrorCode;

  /** Creates a safe workspace operation failure. */
  constructor(code: FsOperationErrorCode) {
    super("The workspace file operation failed.");
    this.code = code;
  }
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function assertActive(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new WorkspaceFileError("fs_operation_failed");
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertProjectPath(path: string): void {
  if (path.split(/[\\/]/u).some((part) => part === ".harness")) {
    throw new WorkspaceFileError("fs_path_invalid");
  }
}

async function projectPath(root: string, path: string, allowMissing = false): Promise<string> {
  assertProjectPath(path);
  try {
    return await resolveWorkspacePath(root, path, { allowMissing });
  } catch {
    throw new WorkspaceFileError("fs_path_invalid");
  }
}

async function readFileAt(path: string): Promise<Buffer> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | NOFOLLOW | NON_BLOCKING);
  } catch (error) {
    throw new WorkspaceFileError(
      errorCode(error) === "ENOENT" ? "fs_file_not_found" : "fs_path_invalid",
    );
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      throw new WorkspaceFileError("fs_not_file");
    }
    if (info.size > DEFAULT_MAX_FILE_BYTES) {
      throw new WorkspaceFileError("fs_quota_exceeded");
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function fileAt(path: string): Promise<{ readonly bytes: Buffer; readonly exists: true } | {
  readonly exists: false;
}> {
  try {
    return { exists: true, bytes: await readFileAt(path) };
  } catch (error) {
    if (error instanceof WorkspaceFileError && error.code === "fs_file_not_found") {
      return { exists: false };
    }
    throw error;
  }
}

async function countWorkspaceBytes(root: string, signal: AbortSignal): Promise<number> {
  let total = 0;
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      assertActive(signal);
      const path = join(directory, entry.name);
      const info = await lstat(path).catch(() => {
        throw new WorkspaceFileError("fs_path_invalid");
      });
      if (info.isSymbolicLink()) {
        throw new WorkspaceFileError("fs_path_invalid");
      }
      if (info.isDirectory()) {
        await visit(path);
      } else if (info.isFile()) {
        if (info.size > DEFAULT_MAX_FILE_BYTES) {
          throw new WorkspaceFileError("fs_quota_exceeded");
        }
        total += info.size;
        if (total > DEFAULT_RUN_QUOTA_BYTES) {
          throw new WorkspaceFileError("fs_quota_exceeded");
        }
      }
    }
  };
  await visit(root);
  return total;
}

function decodeText(bytes: Uint8Array): string | undefined {
  if (bytes.includes(0)) {
    return undefined;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

async function writeFileAt(
  path: string,
  bytes: Uint8Array,
  mode: "create" | "overwrite",
): Promise<void> {
  const flags =
    constants.O_WRONLY |
    constants.O_CREAT |
    NOFOLLOW |
    NON_BLOCKING |
    (mode === "create" ? constants.O_EXCL : constants.O_TRUNC);
  let handle;
  try {
    handle = await open(path, flags, 0o660);
  } catch (error) {
    const code = errorCode(error);
    if (code === "EEXIST") {
      throw new WorkspaceFileError("fs_file_exists");
    }
    if (code === "ENOENT") {
      throw new WorkspaceFileError(
        mode === "overwrite" ? "fs_file_not_found" : "fs_path_invalid",
      );
    }
    throw new WorkspaceFileError("fs_path_invalid");
  }
  try {
    if (!(await handle.stat()).isFile()) {
      throw new WorkspaceFileError("fs_not_file");
    }
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
}

async function listEntries(
  root: string,
  directory: string,
  prefix: string,
  remainingDepth: number,
  limit: number,
  entries: FsListEntry[],
  signal: AbortSignal,
): Promise<boolean> {
  const names = await readdir(directory);
  for (const name of names) {
    assertActive(signal);
    const relativePath = prefix === "." ? name : join(prefix, name);
    const resolved = await projectPath(root, relativePath).catch((error: unknown) => {
      if (error instanceof WorkspaceFileError && error.code === "fs_path_invalid") {
        return undefined;
      }
      throw error;
    });
    if (resolved === undefined) {
      continue;
    }
    const info = await lstat(resolved).catch(() => {
      throw new WorkspaceFileError("fs_path_invalid");
    });
    if (info.isSymbolicLink()) {
      continue;
    }
    if (info.isDirectory()) {
      entries.push({ path: relativePath, type: "directory" });
      if (entries.length > limit) {
        return true;
      }
      if (remainingDepth > 0 && (await listEntries(
        root,
        resolved,
        relativePath,
        remainingDepth - 1,
        limit,
        entries,
        signal,
      ))) {
        return true;
      }
    } else if (info.isFile()) {
      entries.push({ path: relativePath, type: "file", bytes: info.size });
      if (entries.length > limit) {
        return true;
      }
    }
  }
  return false;
}

async function searchFile(
  path: string,
  relativePath: string,
  matcher: (line: string) => boolean,
  limit: number,
  matches: SearchMatch[],
  signal: AbortSignal,
): Promise<boolean> {
  const content = decodeText(await readFileAt(path));
  if (content === undefined) {
    return false;
  }
  for (const [index, line] of content.split(/\r?\n/u).entries()) {
    assertActive(signal);
    if (!matcher(line)) {
      continue;
    }
    matches.push({
      path: relativePath,
      lineNumber: index + 1,
      line: line.slice(0, MAX_SEARCH_LINE_CHARS),
    });
    if (matches.length > limit) {
      return true;
    }
  }
  return false;
}

interface SearchMatch {
  readonly line: string;
  readonly lineNumber: number;
  readonly path: string;
}

async function searchDirectory(
  root: string,
  directory: string,
  prefix: string,
  matcher: (line: string) => boolean,
  limit: number,
  matches: SearchMatch[],
  signal: AbortSignal,
): Promise<boolean> {
  for (const name of await readdir(directory)) {
    assertActive(signal);
    const relativePath = prefix === "." ? name : join(prefix, name);
    const path = await projectPath(root, relativePath).catch((error: unknown) => {
      if (error instanceof WorkspaceFileError && error.code === "fs_path_invalid") {
        return undefined;
      }
      throw error;
    });
    if (path === undefined) {
      continue;
    }
    const info = await lstat(path).catch(() => {
      throw new WorkspaceFileError("fs_path_invalid");
    });
    if (info.isSymbolicLink()) {
      continue;
    }
    if (info.isDirectory()) {
      if (await searchDirectory(root, path, relativePath, matcher, limit, matches, signal)) {
        return true;
      }
    } else if (info.isFile()) {
      if (await searchFile(path, relativePath, matcher, limit, matches, signal)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Provides quota-checked, symlink-safe workspace file operations for one backend.
 *
 * @param workspaceRoot - Shared run workspace parent directory.
 */
export class WorkspaceFileSystem {
  readonly #workspaceRoot: string;
  readonly #mutations = new Map<string, Promise<void>>();

  /** Creates an operation service bound to the shared workspaces directory. */
  constructor(workspaceRoot: string) {
    this.#workspaceRoot = workspaceRoot;
  }

  /** Runs one validated workspace operation for the requested run. */
  async execute(
    runId: Id,
    operation: FsOperation,
    input: unknown,
    signal: AbortSignal,
  ): Promise<FsToolResult> {
    assertActive(signal);
    switch (operation) {
      case "read":
        return this.#read(runId, FsReadInputSchema.parse(input), signal);
      case "write":
        return this.#mutate(runId, signal, () =>
          this.#write(runId, FsWriteInputSchema.parse(input), signal),
        );
      case "edit":
        return this.#mutate(runId, signal, () =>
          this.#edit(runId, FsEditInputSchema.parse(input), signal),
        );
      case "list":
        return this.#list(runId, FsListInputSchema.parse(input), signal);
      case "search":
        return this.#search(runId, FsSearchInputSchema.parse(input), signal);
    }
  }

  async #projectRoot(runId: Id): Promise<string> {
    try {
      return await ensureRunWorkspace(this.#workspaceRoot, runId);
    } catch {
      throw new WorkspaceFileError("fs_path_invalid");
    }
  }

  async #read(runId: Id, input: FsReadInput, signal: AbortSignal): Promise<FsToolResult> {
    const root = await this.#projectRoot(runId);
    const path = await projectPath(root, input.path, true);
    const bytes = await readFileAt(path);
    assertActive(signal);
    if (decodeText(bytes) === undefined) {
      return { binary: true, bytes: bytes.byteLength };
    }
    const offset = input.offset ?? 0;
    const length = input.length ?? MAX_FS_READ_BYTES;
    const selected = bytes.subarray(offset, Math.min(bytes.byteLength, offset + length));
    const content = new TextDecoder().decode(selected);
    return {
      binary: false,
      bytes: selected.byteLength,
      content,
      offset,
      path: input.path,
    };
  }

  async #write(runId: Id, input: FsWriteInput, signal: AbortSignal): Promise<FsToolResult> {
    const bytes = new TextEncoder().encode(input.content);
    if (bytes.byteLength > MAX_FS_WRITE_BYTES) {
      throw new WorkspaceFileError("fs_invalid_input");
    }
    const root = await this.#projectRoot(runId);
    const path = await projectPath(root, input.path, true);
    const current = await fileAt(path);
    if (input.mode === "create" && current.exists && input.expectedSha256 === undefined) {
      throw new WorkspaceFileError("fs_file_exists");
    }
    if (input.mode === "overwrite" && !current.exists) {
      throw new WorkspaceFileError("fs_file_not_found");
    }
    if (input.expectedSha256 !== undefined) {
      const currentHash = current.exists ? sha256(current.bytes) : EMPTY_SHA256;
      if (
        currentHash !== input.expectedSha256 ||
        (input.mode === "create" && current.exists) ||
        sha256(bytes) === input.expectedSha256
      ) {
        throw new WorkspaceFileError("precondition_failed");
      }
    }
    const runRoot = dirname(root);
    const usedBytes = await countWorkspaceBytes(runRoot, signal);
    const replacedBytes = current.exists ? current.bytes.byteLength : 0;
    if (usedBytes - replacedBytes + bytes.byteLength > DEFAULT_RUN_QUOTA_BYTES) {
      throw new WorkspaceFileError("fs_quota_exceeded");
    }
    await writeFileAt(path, bytes, input.mode);
    return {
      bytes: bytes.byteLength,
      path: input.path,
      sha256: sha256(bytes),
    };
  }

  async #edit(runId: Id, input: FsEditInput, signal: AbortSignal): Promise<FsToolResult> {
    const root = await this.#projectRoot(runId);
    const path = await projectPath(root, input.path, true);
    const original = await readFileAt(path);
    if (input.expectedSha256 !== undefined && sha256(original) !== input.expectedSha256) {
      throw new WorkspaceFileError("precondition_failed");
    }
    const decoded = decodeText(original);
    if (decoded === undefined) {
      throw new WorkspaceFileError("fs_not_file");
    }
    let content = decoded;
    for (const edit of input.edits) {
      const start = content.indexOf(edit.oldText);
      if (start < 0) {
        throw new WorkspaceFileError("edit_no_match");
      }
      if (content.indexOf(edit.oldText, start + 1) >= 0) {
        throw new WorkspaceFileError("edit_ambiguous");
      }
      content = `${content.slice(0, start)}${edit.newText}${content.slice(start + edit.oldText.length)}`;
    }
    const bytes = new TextEncoder().encode(content);
    if (
      bytes.byteLength > DEFAULT_MAX_FILE_BYTES ||
      (input.expectedSha256 !== undefined && sha256(bytes) === input.expectedSha256)
    ) {
      throw new WorkspaceFileError(
        input.expectedSha256 === undefined ? "fs_quota_exceeded" : "precondition_failed",
      );
    }
    const usedBytes = await countWorkspaceBytes(dirname(root), signal);
    if (usedBytes - original.byteLength + bytes.byteLength > DEFAULT_RUN_QUOTA_BYTES) {
      throw new WorkspaceFileError("fs_quota_exceeded");
    }
    await writeFileAt(path, bytes, "overwrite");
    return {
      bytes: bytes.byteLength,
      path: input.path,
      sha256: sha256(bytes),
    };
  }

  async #list(runId: Id, input: FsListInput, signal: AbortSignal): Promise<FsToolResult> {
    const root = await this.#projectRoot(runId);
    const directory = await projectPath(root, input.path);
    const info = await lstat(directory);
    if (!info.isDirectory()) {
      throw new WorkspaceFileError("fs_not_directory");
    }
    const entries: FsListEntry[] = [];
    const truncated = await listEntries(
      root,
      directory,
      input.path,
      input.depth,
      input.limit,
      entries,
      signal,
    );
    return { entries: entries.slice(0, input.limit), truncated };
  }

  async #search(runId: Id, input: FsSearchInput, signal: AbortSignal): Promise<FsToolResult> {
    const root = await this.#projectRoot(runId);
    const searchPath = input.path ?? ".";
    const resolved = await projectPath(root, searchPath);
    const info = await lstat(resolved);
    const matches: SearchMatch[] = [];
    const expression = input.regex ? new RegExp(input.query, "u") : undefined;
    const matcher = expression === undefined
      ? (line: string) => line.includes(input.query)
      : (line: string) => expression.test(line);
    const truncated = info.isDirectory()
      ? await searchDirectory(root, resolved, searchPath, matcher, input.limit, matches, signal)
      : info.isFile()
        ? await searchFile(resolved, searchPath, matcher, input.limit, matches, signal)
        : (() => {
            throw new WorkspaceFileError("fs_not_file");
          })();
    return { matches: matches.slice(0, input.limit), truncated };
  }

  async #mutate(
    runId: Id,
    signal: AbortSignal,
    mutation: () => Promise<FsToolResult>,
  ): Promise<FsToolResult> {
    const key = `${this.#workspaceRoot}:${runId}`;
    const previous = this.#mutations.get(key) ?? Promise.resolve();
    let release = (): void => {};
    const current = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    const queued = previous.then(() => current);
    this.#mutations.set(key, queued);
    await previous;
    try {
      assertActive(signal);
      return await mutation();
    } finally {
      release();
      if (this.#mutations.get(key) === queued) {
        this.#mutations.delete(key);
      }
    }
  }
}
