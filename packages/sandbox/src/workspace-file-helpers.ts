// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { HarnessError } from "@harness/schemas";
import { resolveWorkspacePath } from "./workspace.js";
import type { FsListEntry, FsOperationErrorCode } from "./fs-tools.js";

export const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const DEFAULT_RUN_QUOTA_BYTES = 500 * 1024 * 1024;
const MAX_SEARCH_LINE_CHARS = 2048;
const NOFOLLOW = constants.O_NOFOLLOW;
const NON_BLOCKING = constants.O_NONBLOCK;
export const EMPTY_SHA256 = createHash("sha256").update(new Uint8Array()).digest("hex");

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

/** Throws the closed operation failure code when cancellation has been requested. */
export function assertActive(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new WorkspaceFileError("fs_operation_failed");
  }
}

/** Returns the lowercase SHA-256 digest of file bytes. */
export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertProjectPath(path: string): void {
  if (path.split(/[\\/]/u).some((part) => part === ".harness")) {
    throw new WorkspaceFileError("fs_path_invalid");
  }
}

/** Resolves an allowed path under the project root, optionally allowing a missing leaf. */
export async function projectPath(
  root: string,
  path: string,
  allowMissing = false,
): Promise<string> {
  assertProjectPath(path);
  try {
    return await resolveWorkspacePath(root, path, { allowMissing });
  } catch {
    throw new WorkspaceFileError("fs_path_invalid");
  }
}

/** Reads a regular, bounded file without following a final symlink. */
export async function readFileAt(path: string): Promise<Buffer> {
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

/** Reads a file if present, returning a discriminated missing-file result. */
export async function fileAt(
  path: string,
): Promise<{ readonly bytes: Buffer; readonly exists: true } | { readonly exists: false }> {
  try {
    return { exists: true, bytes: await readFileAt(path) };
  } catch (error) {
    if (error instanceof WorkspaceFileError && error.code === "fs_file_not_found") {
      return { exists: false };
    }
    throw error;
  }
}

/** Counts regular workspace file bytes while enforcing per-file and per-run quotas. */
export async function countWorkspaceBytes(root: string, signal: AbortSignal): Promise<number> {
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

/** Decodes valid UTF-8 text, returning undefined for binary or invalid byte sequences. */
export function decodeText(bytes: Uint8Array): string | undefined {
  if (bytes.includes(0)) {
    return undefined;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** Creates or overwrites a regular file without following the final path component. */
export async function writeFileAt(
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

interface ListContext {
  readonly root: string;
  readonly prefix: string;
  readonly remainingDepth: number;
  readonly limit: number;
  readonly entries: FsListEntry[];
  readonly signal: AbortSignal;
}

/** Traverses safe entries up to the requested depth and reports whether the limit was exceeded. */
export async function listEntries(directory: string, context: ListContext): Promise<boolean> {
  const names = await readdir(directory);
  for (const name of names) {
    assertActive(context.signal);
    const relativePath = context.prefix === "." ? name : join(context.prefix, name);
    const resolved = await projectPath(context.root, relativePath).catch((error: unknown) => {
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
      context.entries.push({ path: relativePath, type: "directory" });
      if (context.entries.length > context.limit) {
        return true;
      }
      if (
        context.remainingDepth > 0 &&
        (await listEntries(resolved, {
          ...context,
          prefix: relativePath,
          remainingDepth: context.remainingDepth - 1,
        }))
      ) {
        return true;
      }
    } else if (info.isFile()) {
      context.entries.push({ path: relativePath, type: "file", bytes: info.size });
      if (context.entries.length > context.limit) {
        return true;
      }
    }
  }
  return false;
}

/** One bounded line match returned by workspace search. */
export interface SearchMatch {
  readonly line: string;
  readonly lineNumber: number;
  readonly path: string;
}

interface SearchContext {
  readonly root: string;
  readonly prefix: string;
  readonly matcher: (line: string) => boolean;
  readonly limit: number;
  readonly matches: SearchMatch[];
  readonly signal: AbortSignal;
}

/** Adds bounded text matches from one file and reports whether the result limit was exceeded. */
export async function searchFile(
  path: string,
  relativePath: string,
  context: SearchContext,
): Promise<boolean> {
  const content = decodeText(await readFileAt(path));
  if (content === undefined) {
    return false;
  }
  for (const [index, line] of content.split(/\r?\n/u).entries()) {
    assertActive(context.signal);
    if (!context.matcher(line)) {
      continue;
    }
    context.matches.push({
      path: relativePath,
      lineNumber: index + 1,
      line: line.slice(0, MAX_SEARCH_LINE_CHARS),
    });
    if (context.matches.length > context.limit) {
      return true;
    }
  }
  return false;
}

/** Searches files recursively while skipping unsafe symlink entries. */
export async function searchDirectory(
  directory: string,
  context: SearchContext,
): Promise<boolean> {
  for (const name of await readdir(directory)) {
    assertActive(context.signal);
    const relativePath = context.prefix === "." ? name : join(context.prefix, name);
    const path = await projectPath(context.root, relativePath).catch((error: unknown) => {
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
      if (
        await searchDirectory(path, {
          ...context,
          prefix: relativePath,
        })
      ) {
        return true;
      }
    } else if (info.isFile()) {
      if (await searchFile(path, relativePath, context)) {
        return true;
      }
    }
  }
  return false;
}
