// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, rename, unlink, link } from "node:fs/promises";
import type { Stats } from "node:fs";
import process from "node:process";
import { dirname, join } from "node:path";
import { HarnessError } from "@harness/schemas";
import { resolveWorkspacePath } from "./workspace.js";
import type { FsListEntry, FsOperationErrorCode } from "./fs-tools.js";

export const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const DEFAULT_RUN_QUOTA_BYTES = 500 * 1024 * 1024;
const MAX_SEARCH_LINE_CHARS = 2048;
const MAX_SEARCH_BYTES = 10 * 1024 * 1024;
const MAX_SEARCH_FILES = 1000;
const NOFOLLOW = constants.O_NOFOLLOW;
const NON_BLOCKING = constants.O_NONBLOCK;
export const EMPTY_SHA256 = createHash("sha256").update(new Uint8Array()).digest("hex");
let temporaryFileSequence = 0;

export interface WorkspaceFileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly mtimeMs: number;
  readonly size: number;
  readonly mode: number;
}

export interface WorkspaceFileSnapshot {
  readonly bytes: Buffer;
  readonly identity: WorkspaceFileIdentity;
}

function fileIdentity(info: Stats): WorkspaceFileIdentity {
  if (info.nlink > 1) {
    throw new WorkspaceFileError("fs_path_invalid");
  }
  return {
    dev: info.dev,
    ino: info.ino,
    mtimeMs: info.mtimeMs,
    size: info.size,
    mode: info.mode,
  };
}

function sameFile(left: WorkspaceFileIdentity, right: WorkspaceFileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mtimeMs === right.mtimeMs &&
    left.size === right.size
  );
}

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

/** Reads a regular, bounded file without following a final symlink or hard-link alias. */
export async function readFileSnapshotAt(path: string): Promise<WorkspaceFileSnapshot> {
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
    const identity = fileIdentity(info);
    if (info.size > DEFAULT_MAX_FILE_BYTES) {
      throw new WorkspaceFileError("workspace_quota_exceeded");
    }
    return { bytes: await handle.readFile(), identity };
  } finally {
    await handle.close();
  }
}

/** Reads a regular, bounded file without following a final symlink or hard-link alias. */
export async function readFileAt(path: string): Promise<Buffer> {
  return (await readFileSnapshotAt(path)).bytes;
}

/** Reads a UTF-8 range while returning only bytes consumed at character boundaries. */
export async function readTextRangeAt(
  path: string,
  requestedOffset: number,
  requestedLength: number,
): Promise<
  | { readonly binary: true; readonly fileBytes: number }
  | {
      readonly binary: false;
      readonly fileBytes: number;
      readonly bytes: number;
      readonly content: string;
      readonly offset: number;
    }
> {
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
    fileIdentity(info);
    if (info.size > DEFAULT_MAX_FILE_BYTES) {
      throw new WorkspaceFileError("workspace_quota_exceeded");
    }
    const sniffLength = Math.min(info.size, 8192);
    const sniff = Buffer.alloc(sniffLength);
    const sniffResult = await handle.read(sniff, 0, sniffLength, 0);
    const sample = sniff.subarray(0, sniffResult.bytesRead);
    if (sample.includes(0) || decodeUtf8Prefix(sample, sniffResult.bytesRead < info.size) === undefined) {
      return { binary: true, fileBytes: info.size };
    }
    let offset = Math.min(requestedOffset, info.size);
    const prefixLength = Math.min(3, info.size - offset);
    if (prefixLength > 0) {
      const prefix = Buffer.alloc(prefixLength);
      const result = await handle.read(prefix, 0, prefixLength, offset);
      let skip = 0;
      while (skip < result.bytesRead && (prefix[skip] ?? 0) >= 0x80 && (prefix[skip] ?? 0) <= 0xbf) {
        skip += 1;
      }
      offset += skip;
    }
    if (requestedLength === 0) {
      return { binary: false, fileBytes: info.size, bytes: 0, content: "", offset };
    }
    const rangeLength = Math.min(info.size - offset, requestedLength + 3);
    const range = Buffer.alloc(rangeLength);
    const result = await handle.read(range, 0, rangeLength, offset);
    let consumed = Math.min(result.bytesRead, requestedLength);
    while (consumed > 0 && decodeText(range.subarray(0, consumed)) === undefined) {
      consumed -= 1;
    }
    const content = decodeText(range.subarray(0, consumed));
    if (content === undefined) {
      return { binary: true, fileBytes: info.size };
    }
    return {
      binary: false,
      fileBytes: info.size,
      bytes: consumed,
      content,
      offset,
    };
  } finally {
    await handle.close();
  }
}

function decodeUtf8Prefix(bytes: Uint8Array, mayBeTruncated: boolean): string | undefined {
  const content = decodeText(bytes);
  if (content !== undefined || !mayBeTruncated) {
    return content;
  }
  for (let suffix = 1; suffix <= 3 && suffix <= bytes.byteLength; suffix += 1) {
    const prefix = decodeText(bytes.subarray(0, bytes.byteLength - suffix));
    if (prefix !== undefined) {
      return prefix;
    }
  }
  return undefined;
}

/** Reads a file if present, returning a discriminated missing-file result. */
export async function fileAt(
  path: string,
): Promise<
  | { readonly bytes: Buffer; readonly exists: true; readonly identity: WorkspaceFileIdentity }
  | { readonly exists: false }
> {
  try {
    const snapshot = await readFileSnapshotAt(path);
    return { exists: true, ...snapshot };
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
        continue;
      }
      if (info.isDirectory()) {
        if (directory === root && entry.name === ".harness") {
          continue;
        }
        await visit(path);
      } else if (info.isFile()) {
        total += info.size;
        if (total > DEFAULT_RUN_QUOTA_BYTES) {
          throw new WorkspaceFileError("workspace_quota_exceeded");
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

/** Atomically creates or replaces a regular file after validating its prior identity. */
export async function writeFileAt(
  path: string,
  bytes: Uint8Array,
  mode: "create" | "overwrite",
  signal: AbortSignal,
  expectedIdentity?: WorkspaceFileIdentity,
): Promise<void> {
  let handle;
  let temporaryPath: string | undefined;
  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      temporaryFileSequence += 1;
      const candidatePath = join(
        dirname(path),
        `.harness-fs-${String(process.pid)}-${String(temporaryFileSequence)}`,
      );
      try {
        handle = await open(
          candidatePath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW | NON_BLOCKING,
          expectedIdentity === undefined ? 0o660 : expectedIdentity.mode & 0o777,
        );
        temporaryPath = candidatePath;
        if (expectedIdentity !== undefined) {
          await handle.chmod(expectedIdentity.mode & 0o777);
        }
        break;
      } catch (error) {
        if (errorCode(error) !== "EEXIST") {
          throw error;
        }
      }
    }
    if (handle === undefined || temporaryPath === undefined) {
      throw new WorkspaceFileError("fs_operation_failed");
    }
    assertActive(signal);
    await handle.writeFile(bytes, { signal });
    await handle.sync();
    await handle.close();
    handle = undefined;
    assertActive(signal);

    const target = await lstat(path).catch((error: unknown) => {
      if (errorCode(error) === "ENOENT") {
        return undefined;
      }
      throw error;
    });
    if (mode === "create") {
      if (target !== undefined) {
        throw new WorkspaceFileError("fs_file_exists");
      }
      try {
        await link(temporaryPath, path);
      } catch (error) {
        if (errorCode(error) === "EEXIST") {
          throw new WorkspaceFileError("fs_file_exists");
        }
        throw error;
      }
      await unlink(temporaryPath);
    } else {
      if (target === undefined) {
        throw new WorkspaceFileError("fs_file_not_found");
      }
      if (!target.isFile()) {
        throw new WorkspaceFileError("fs_not_file");
      }
      const currentIdentity = fileIdentity(target);
      if (expectedIdentity === undefined || !sameFile(currentIdentity, expectedIdentity)) {
        throw new WorkspaceFileError("precondition_failed");
      }
      await rename(temporaryPath, path);
    }
    temporaryPath = undefined;
  } finally {
    if (handle !== undefined) {
      await handle.close();
    }
    if (temporaryPath !== undefined) {
      await unlink(temporaryPath).catch(() => undefined);
    }
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
  readonly state: { filesVisited: number; bytesScanned: number };
}

/** Adds bounded text matches from one file and reports whether any search cap was hit. */
export async function searchFile(
  path: string,
  relativePath: string,
  context: SearchContext,
): Promise<boolean> {
  const handle = await open(path, constants.O_RDONLY | NOFOLLOW | NON_BLOCKING).catch(() => {
    throw new WorkspaceFileError("fs_path_invalid");
  });
  let content: string | undefined;
  let capHit = false;
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      return false;
    }
    fileIdentity(info);
    const remaining = Math.max(0, MAX_SEARCH_BYTES - context.state.bytesScanned);
    if (remaining === 0) {
      return info.size > 0;
    }
    const length = Math.min(info.size, remaining);
    const bytes = Buffer.alloc(length);
    const result = await handle.read(bytes, 0, length, 0);
    context.state.bytesScanned += result.bytesRead;
    capHit = info.size > result.bytesRead;
    content = decodeUtf8Prefix(bytes.subarray(0, result.bytesRead), capHit);
  } finally {
    await handle.close();
  }
  if (content === undefined) {
    return capHit;
  }
  let line = "";
  let lineLength = 0;
  let lineNumber = 1;
  const addMatch = (): boolean => {
    if (lineLength > MAX_SEARCH_LINE_CHARS) {
      capHit = true;
    }
    if (context.matcher(line)) {
      context.matches.push({ path: relativePath, lineNumber, line });
      if (context.matches.length > context.limit) {
        return true;
      }
    }
    return false;
  };
  for (let index = 0; index < content.length; index += 1) {
    if (index % MAX_SEARCH_LINE_CHARS === 0) {
      assertActive(context.signal);
    }
    const character = content[index] ?? "";
    if (character === "\n") {
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
        lineLength -= 1;
      }
      if (addMatch()) {
        return true;
      }
      lineNumber += 1;
      line = "";
      lineLength = 0;
    } else {
      if (lineLength < MAX_SEARCH_LINE_CHARS) {
        line += character;
      }
      lineLength += 1;
    }
  }
  if (addMatch()) {
    return true;
  }
  return capHit;
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
      if (context.state.filesVisited >= MAX_SEARCH_FILES) {
        return true;
      }
      context.state.filesVisited += 1;
      if (await searchFile(path, relativePath, context)) {
        return true;
      }
    }
  }
  return false;
}
