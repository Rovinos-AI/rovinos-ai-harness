// SPDX-License-Identifier: Apache-2.0
import { aesGcmDecrypt, aesGcmEncrypt } from "@harness/crypto";
import { Code, HarnessError, Id } from "@harness/schemas";
import type { KeyProvider, WorkspaceRef } from "@harness/schemas";
import { chmod, lstat, mkdir, rename, rm } from "node:fs/promises";
import { join, posix, win32 } from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as tar from "tar";

const ENCRYPTION_HEADER = Buffer.from("WSENC01", "ascii");
const WORKSPACE_REF_PATTERN = /^ws:([0-9A-HJKMNP-TV-Z]{26}):([a-f0-9]{16})$/u;

/** Error raised when a workspace snapshot cannot be read or restored safely. */
export class WorkspaceSnapshotError extends HarnessError {
  readonly code = "workspace_snapshot_invalid";

  constructor() {
    super("The workspace snapshot is invalid.");
  }
}

/** Error raised when a snapshot exceeds its configured size limit. */
export class SnapshotTooLargeError extends HarnessError {
  readonly code = "snapshot_too_large";

  constructor() {
    super("The workspace snapshot exceeds its size limit.");
  }
}

/** Error raised when a snapshot archive contains an unsafe entry. */
export class UnsafeWorkspaceSnapshotError extends HarnessError {
  readonly code = "workspace_snapshot_unsafe";

  constructor() {
    super("The workspace snapshot contains an unsafe entry.");
  }
}

/** Splits a validated workspace reference into its snapshot ID and stored-byte digest. */
export function workspaceSnapshotRefParts(ref: WorkspaceRef): {
  snapshotId: Id;
  digest: string;
} {
  const match = WORKSPACE_REF_PATTERN.exec(ref);
  const snapshotId = match?.[1];
  const digest = match?.[2];
  if (snapshotId === undefined || digest === undefined) {
    throw new WorkspaceSnapshotError();
  }
  return { snapshotId: Id.parse(snapshotId), digest };
}

function isSafeArchivePath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  return (
    normalized.length <= 4096 &&
    !normalized.includes("\0") &&
    !normalized.startsWith("/") &&
    !win32.isAbsolute(path) &&
    !/^[A-Za-z]:/u.test(path) &&
    !normalized.split("/").some((segment) => segment === ".." || segment.length > 255)
  );
}

function archiveRelativePath(path: string): string {
  if (!isSafeArchivePath(path)) {
    throw new UnsafeWorkspaceSnapshotError();
  }
  return posix.normalize(path.replaceAll("\\", "/")).replace(/^\.\//u, "");
}

/** Compresses the workspace while excluding ephemeral per-run scratch files. */
export async function createWorkspaceArchive(
  runRoot: string,
  maxSnapshotBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  const sink = new Writable({
    write: (chunk: Buffer, _encoding, callback) => {
      size += chunk.byteLength;
      if (size > maxSnapshotBytes) {
        callback(new SnapshotTooLargeError());
        return;
      }
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  try {
    const archive = tar.c(
      {
        cwd: runRoot,
        gzip: true,
        portable: true,
        filter: (path) => {
          const segments = path
            .replaceAll("\\", "/")
            .split("/")
            .filter((segment) => segment !== "" && segment !== ".");
          return !(segments[0] === ".harness" && segments[1] === "tmp");
        },
      },
      ["."],
    );
    await pipeline(archive, sink);
    return Buffer.concat(chunks, size);
  } catch (error) {
    for (const chunk of chunks) {
      chunk.fill(0);
    }
    if (error instanceof SnapshotTooLargeError) {
      throw error;
    }
    throw new WorkspaceSnapshotError();
  }
}

/** Optionally encrypts compressed workspace bytes with the configured key provider. */
export async function encryptWorkspaceArchive(
  archive: Buffer,
  options: {
    readonly runId: Id;
    readonly snapshotId: Id;
    readonly enabled: boolean;
    readonly provider?: KeyProvider;
  },
): Promise<Buffer> {
  const { runId, snapshotId, enabled, provider } = options;
  if (!enabled) {
    return archive;
  }
  if (provider === undefined) {
    throw new WorkspaceSnapshotError();
  }
  let key: Buffer | undefined;
  try {
    const keyId = Code.parse(provider.currentKeyId());
    key = Buffer.from(await provider.getKey(keyId));
    const encrypted = aesGcmEncrypt(key, archive, Buffer.from(`${runId}:${snapshotId}`));
    const encodedKeyId = Buffer.from(keyId, "utf8");
    return Buffer.concat([
      ENCRYPTION_HEADER,
      Buffer.from([encodedKeyId.byteLength]),
      encodedKeyId,
      encrypted,
    ]);
  } catch {
    throw new WorkspaceSnapshotError();
  } finally {
    key?.fill(0);
  }
}

/** Verifies and decrypts stored snapshot bytes when an encryption envelope is present. */
export async function decryptWorkspaceArchive(
  storedBytes: Buffer,
  runId: Id,
  snapshotId: Id,
  provider?: KeyProvider,
): Promise<Buffer> {
  if (!storedBytes.subarray(0, ENCRYPTION_HEADER.byteLength).equals(ENCRYPTION_HEADER)) {
    return Buffer.from(storedBytes);
  }
  const keyIdLength = storedBytes[ENCRYPTION_HEADER.byteLength];
  if (keyIdLength === undefined || keyIdLength < 1) {
    throw new WorkspaceSnapshotError();
  }
  const keyOffset = ENCRYPTION_HEADER.byteLength + 1;
  const keyId = Code.safeParse(
    storedBytes.subarray(keyOffset, keyOffset + keyIdLength).toString("utf8"),
  );
  if (!keyId.success || provider === undefined) {
    throw new WorkspaceSnapshotError();
  }
  let key: Buffer | undefined;
  try {
    key = Buffer.from(await provider.getKey(keyId.data));
    return Buffer.from(
      aesGcmDecrypt(
        key,
        storedBytes.subarray(keyOffset + keyIdLength),
        Buffer.from(`${runId}:${snapshotId}`),
      ),
    );
  } catch {
    throw new WorkspaceSnapshotError();
  } finally {
    key?.fill(0);
  }
}

interface ArchiveExtractionState {
  totalBytes: number;
  rootMode?: number;
  rejection?: HarnessError;
}

type ArchiveFilterEntry = Parameters<NonNullable<tar.TarOptionsWithAliases["filter"]>>[1];

function rejectArchiveEntry(state: ArchiveExtractionState, error: HarnessError): false {
  Object.assign(state, { rejection: state.rejection ?? error });
  return false;
}

function resolveArchiveEntryPath(
  entry: ArchiveFilterEntry,
  state: ArchiveExtractionState,
): string | undefined {
  if (!("type" in entry)) {
    rejectArchiveEntry(state, new UnsafeWorkspaceSnapshotError());
    return undefined;
  }
  try {
    return archiveRelativePath(entry.path);
  } catch {
    rejectArchiveEntry(state, new UnsafeWorkspaceSnapshotError());
    return undefined;
  }
}

function entryHasAllowedType(
  entry: ArchiveFilterEntry,
): entry is Extract<ArchiveFilterEntry, { type: string }> {
  return (
    "type" in entry &&
    (entry.type === "Directory" || entry.type === "File" || entry.type === "OldFile")
  );
}

function entryFitsSnapshotLimits(
  entry: ArchiveFilterEntry,
  state: ArchiveExtractionState,
  maxFileBytes: number,
  maxSnapshotBytes: number,
): boolean {
  if (!("type" in entry) || entry.type === "Directory") {
    return true;
  }
  const totalBytes = state.totalBytes + entry.size;
  Object.assign(state, { totalBytes });
  if (entry.size > maxFileBytes || totalBytes > maxSnapshotBytes) {
    return rejectArchiveEntry(state, new SnapshotTooLargeError());
  }
  return true;
}

function filterArchiveEntry(
  entry: ArchiveFilterEntry,
  state: ArchiveExtractionState,
  maxFileBytes: number,
  maxSnapshotBytes: number,
): boolean {
  const relativePath = resolveArchiveEntryPath(entry, state);
  if (relativePath === undefined) {
    return false;
  }
  if (!entryHasAllowedType(entry)) {
    return rejectArchiveEntry(state, new UnsafeWorkspaceSnapshotError());
  }
  if (!entryFitsSnapshotLimits(entry, state, maxFileBytes, maxSnapshotBytes)) {
    return false;
  }
  const mode = (entry.mode ?? (entry.type === "Directory" ? 0o755 : 0o644)) & 0o777;
  Object.assign(entry, { mode });
  if (relativePath === ".") {
    Object.assign(state, { rootMode: mode });
  }
  return true;
}

/** Safely extracts archive entries into a private temporary workspace directory. */
export async function extractWorkspaceArchive(
  archive: Buffer,
  destination: string,
  maxFileBytes: number,
  maxSnapshotBytes: number,
): Promise<void> {
  const state: ArchiveExtractionState = { totalBytes: 0 };
  try {
    const extractor = tar.x({
      cwd: destination,
      strict: true,
      preservePaths: true,
      preserveOwner: false,
      unlink: true,
      chmod: true,
      processUmask: 0,
      maxDecompressionRatio: 1000,
      filter: (_path, entry) => filterArchiveEntry(entry, state, maxFileBytes, maxSnapshotBytes),
    });
    await pipeline(Readable.from([archive]), extractor);
    if (state.rejection !== undefined) {
      throw state.rejection;
    }
    await chmod(destination, state.rootMode ?? 0o700);
  } catch (error) {
    if (error instanceof HarnessError) {
      throw error;
    }
    throw new WorkspaceSnapshotError();
  }
}

function codeOf(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

async function recoverInterruptedWorkspaceSwap(runRoot: string, oldRoot: string): Promise<void> {
  const oldInfo = await lstat(oldRoot).catch((error: unknown) => {
    if (codeOf(error) === "ENOENT") {
      return undefined;
    }
    throw new WorkspaceSnapshotError();
  });
  if (oldInfo === undefined) {
    return;
  }
  if (!oldInfo.isDirectory() || oldInfo.isSymbolicLink()) {
    throw new WorkspaceSnapshotError();
  }
  const currentInfo = await lstat(runRoot).catch((error: unknown) => {
    if (codeOf(error) === "ENOENT") {
      return undefined;
    }
    throw new WorkspaceSnapshotError();
  });
  if (currentInfo === undefined) {
    await rename(oldRoot, runRoot);
  } else {
    await rm(oldRoot, { recursive: true, force: true });
  }
}

async function swapRestoredWorkspace(
  temporaryRoot: string,
  runRoot: string,
  oldRoot: string,
): Promise<void> {
  const existing = await lstat(runRoot).catch((error: unknown) => {
    if (codeOf(error) === "ENOENT") {
      return undefined;
    }
    throw new WorkspaceSnapshotError();
  });
  if (existing !== undefined) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw new WorkspaceSnapshotError();
    }
    await rm(oldRoot, { recursive: true, force: true });
    await rename(runRoot, oldRoot);
  }
  try {
    await rename(temporaryRoot, runRoot);
  } catch {
    if (existing !== undefined) {
      await rename(oldRoot, runRoot);
    }
    throw new WorkspaceSnapshotError();
  }
  if (existing !== undefined) {
    await rm(oldRoot, { recursive: true, force: true });
  }
}

/** Installs a validated snapshot archive with a recoverable atomic workspace swap. */
export async function restoreWorkspaceArchive(options: {
  readonly archive: Buffer;
  readonly workspaceRoot: string;
  readonly runId: Id;
  readonly temporaryId: Id;
  readonly maxFileBytes: number;
  readonly maxSnapshotBytes: number;
}): Promise<void> {
  const { archive, workspaceRoot, runId, temporaryId, maxFileBytes, maxSnapshotBytes } = options;
  const temporaryRoot = join(workspaceRoot, `.${runId}.restore-${temporaryId}`);
  const runRoot = join(workspaceRoot, runId);
  const oldRoot = join(workspaceRoot, `${runId}.old`);
  let createdTemporaryRoot = false;
  try {
    await recoverInterruptedWorkspaceSwap(runRoot, oldRoot);
    await mkdir(temporaryRoot, { recursive: false, mode: 0o700 });
    createdTemporaryRoot = true;
    await extractWorkspaceArchive(archive, temporaryRoot, maxFileBytes, maxSnapshotBytes);
    await swapRestoredWorkspace(temporaryRoot, runRoot, oldRoot);
  } catch (error) {
    if (error instanceof HarnessError) {
      throw error;
    }
    throw new WorkspaceSnapshotError();
  } finally {
    if (createdTemporaryRoot) {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }
}
