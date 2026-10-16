// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, posix, win32 } from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { aesGcmDecrypt, aesGcmEncrypt } from "@harness/crypto";
import { Code, HarnessError, Id, WorkspaceRef } from "@harness/schemas";
import type { KeyProvider } from "@harness/schemas";
import * as tar from "tar";
import { ensureRunWorkspace } from "./workspace.js";

const DEFAULT_MAX_SNAPSHOT_BYTES = 1024 * 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const DEFAULT_SNAPSHOT_KEEP = 5;
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

/** Inputs for the filesystem-backed workspace snapshotter. */
export interface WorkspaceSnapshotterOptions {
  /** Parent directory containing one directory per run. */
  readonly workspaceRoot: string;
  /** Directory in which per-run snapshot archives are stored. */
  readonly snapshotRoot: string;
  /** ULID source used for snapshot names and atomic temporary paths. */
  readonly ids: { next(): string };
  /** Maximum stored archive size; defaults to 1 GiB. */
  readonly maxSnapshotBytes?: number;
  /** Maximum uncompressed file and aggregate size; per-file defaults to 10 MiB. */
  readonly maxFileBytes?: number;
  /** Number of latest snapshot files to retain per run; defaults to 5. */
  readonly snapshotKeep?: number;
  /** Encrypt archives with AES-256-GCM using the supplied provider. */
  readonly snapshotEncryption?: boolean;
  /** Key provider used when snapshot encryption is enabled. */
  readonly keyProvider?: KeyProvider;
}

function isWithinPath(path: string): boolean {
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
  if (!isWithinPath(path)) {
    throw new UnsafeWorkspaceSnapshotError();
  }
  return posix.normalize(path.replaceAll("\\", "/")).replace(/^\.\//u, "");
}

function workspaceRefParts(ref: WorkspaceRef): { snapshotId: Id; digest: string } {
  const match = WORKSPACE_REF_PATTERN.exec(ref);
  const snapshotId = match?.[1];
  const digest = match?.[2];
  if (snapshotId === undefined || digest === undefined) {
    throw new WorkspaceSnapshotError();
  }
  return { snapshotId: Id.parse(snapshotId), digest };
}

function codeOf(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

async function assertPlainDirectory(path: string): Promise<void> {
  const info = await lstat(path).catch(() => {
    throw new WorkspaceSnapshotError();
  });
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new WorkspaceSnapshotError();
  }
}

/** Creates checksummed, atomic workspace archives and restores them through a safe tar filter. */
export class WorkspaceSnapshotter {
  readonly #maxSnapshotBytes: number;
  readonly #maxFileBytes: number;
  readonly #snapshotKeep: number;
  readonly #snapshotEncryption: boolean;

  constructor(private readonly options: WorkspaceSnapshotterOptions) {
    this.#maxSnapshotBytes = options.maxSnapshotBytes ?? DEFAULT_MAX_SNAPSHOT_BYTES;
    this.#maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.#snapshotKeep = options.snapshotKeep ?? DEFAULT_SNAPSHOT_KEEP;
    this.#snapshotEncryption = options.snapshotEncryption ?? false;
    if (
      !Number.isSafeInteger(this.#maxSnapshotBytes) ||
      this.#maxSnapshotBytes < 1 ||
      !Number.isSafeInteger(this.#maxFileBytes) ||
      this.#maxFileBytes < 1 ||
      !Number.isSafeInteger(this.#snapshotKeep) ||
      this.#snapshotKeep < 1
    ) {
      throw new RangeError("Workspace snapshot limits must be positive safe integers.");
    }
    if (this.#snapshotEncryption && options.keyProvider === undefined) {
      throw new WorkspaceSnapshotError();
    }
  }

  /**
   * Compress and atomically persist a run workspace, returning its checked reference.
   *
   * `.harness/tmp` is excluded. The ref digest covers the exact bytes written to disk.
   *
   * @param runId - Run whose workspace will be captured.
   * @returns A workspace reference suitable for a checkpoint.
   */
  async snapshot(runId: string): Promise<WorkspaceRef> {
    const validatedRunId = Id.parse(runId);
    const snapshotId = Id.parse(this.options.ids.next());
    const workspaceRoot = await this.#ensureRoot(this.options.workspaceRoot);
    const runRoot = join(workspaceRoot, validatedRunId);
    await ensureRunWorkspace(workspaceRoot, validatedRunId);
    await assertPlainDirectory(runRoot);
    const snapshotDirectory = await this.#ensureRunSnapshotDirectory(validatedRunId);
    const temporaryPath = join(snapshotDirectory, `.${snapshotId}.tmp`);
    const snapshotPath = join(snapshotDirectory, `${snapshotId}.tar.gz`);
    let archive: Buffer | undefined;
    try {
      archive = await this.#createArchive(runRoot);
      const storedBytes = await this.#encryptIfConfigured(validatedRunId, snapshotId, archive);
      if (storedBytes.byteLength > this.#maxSnapshotBytes) {
        throw new SnapshotTooLargeError();
      }
      const digest = createHash("sha256").update(storedBytes).digest("hex");
      await writeFile(temporaryPath, storedBytes, { flag: "wx", mode: 0o600 });
      await rename(temporaryPath, snapshotPath);
      return WorkspaceRef.parse(`ws:${snapshotId}:${digest.slice(0, 16)}`);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      if (error instanceof HarnessError) {
        throw error;
      }
      throw new WorkspaceSnapshotError();
    } finally {
      archive?.fill(0);
    }
  }

  /**
   * Verify and safely extract a snapshot before atomically replacing a run workspace.
   *
   * @param runId - Run whose workspace will be replaced.
   * @param ref - Checkpoint workspace reference.
   */
  async restore(runId: string, ref: WorkspaceRef): Promise<void> {
    const validatedRunId = Id.parse(runId);
    const { snapshotId, digest } = workspaceRefParts(WorkspaceRef.parse(ref));
    const workspaceRoot = await this.#ensureRoot(this.options.workspaceRoot);
    const snapshotDirectory = await this.#ensureRunSnapshotDirectory(validatedRunId);
    const snapshotPath = join(snapshotDirectory, `${snapshotId}.tar.gz`);
    const archiveStat = await lstat(snapshotPath).catch(() => {
      throw new WorkspaceSnapshotError();
    });
    if (
      !archiveStat.isFile() ||
      archiveStat.isSymbolicLink() ||
      archiveStat.size > this.#maxSnapshotBytes
    ) {
      throw archiveStat.size > this.#maxSnapshotBytes
        ? new SnapshotTooLargeError()
        : new WorkspaceSnapshotError();
    }
    let storedBytes: Buffer;
    try {
      storedBytes = await readFile(snapshotPath);
    } catch {
      throw new WorkspaceSnapshotError();
    }
    const actualDigest = createHash("sha256").update(storedBytes).digest("hex").slice(0, 16);
    if (actualDigest !== digest) {
      throw new WorkspaceSnapshotError();
    }
    const archive = await this.#decryptIfEncrypted(validatedRunId, snapshotId, storedBytes);
    const temporaryId = Id.parse(this.options.ids.next());
    const temporaryRoot = join(workspaceRoot, `.${validatedRunId}.restore-${temporaryId}`);
    const runRoot = join(workspaceRoot, validatedRunId);
    const oldRoot = join(workspaceRoot, `${validatedRunId}.old`);
    let movedOldWorkspace = false;
    try {
      await this.#recoverInterruptedSwap(runRoot, oldRoot);
      await mkdir(temporaryRoot, { recursive: false, mode: 0o700 });
      await this.#extractArchive(archive, temporaryRoot);
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
        movedOldWorkspace = true;
      }
      try {
        await rename(temporaryRoot, runRoot);
      } catch {
        if (movedOldWorkspace) {
          await rename(oldRoot, runRoot);
          movedOldWorkspace = false;
        }
        throw new WorkspaceSnapshotError();
      }
      if (movedOldWorkspace) {
        await rm(oldRoot, { recursive: true, force: true });
      }
    } catch (error) {
      if (error instanceof HarnessError) {
        throw error;
      }
      throw new WorkspaceSnapshotError();
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
      archive.fill(0);
      storedBytes.fill(0);
    }
  }

  /** Returns whether a non-symlink run workspace currently exists. */
  async hasWorkspace(runId: string): Promise<boolean> {
    const validatedRunId = Id.parse(runId);
    const workspaceRoot = await this.#ensureRoot(this.options.workspaceRoot);
    const runRoot = join(workspaceRoot, validatedRunId);
    const info = await lstat(runRoot).catch((error: unknown) => {
      if (codeOf(error) === "ENOENT") {
        return undefined;
      }
      throw new WorkspaceSnapshotError();
    });
    if (info === undefined) {
      return false;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new WorkspaceSnapshotError();
    }
    return true;
  }

  /** Prunes old archives to the same default retention count used by event-store snapshots. */
  async prune(runId: string): Promise<void> {
    const directory = await this.#ensureRunSnapshotDirectory(Id.parse(runId));
    const archives: { readonly path: string; readonly name: string }[] = [];
    for (const name of await readdir(directory)) {
      if (!/^[0-9A-HJKMNP-TV-Z]{26}\.tar\.gz$/u.test(name)) {
        continue;
      }
      const path = join(directory, name);
      const info = await lstat(path);
      if (info.isFile() && !info.isSymbolicLink()) {
        archives.push({ path, name });
      }
    }
    archives.sort((left, right) => right.name.localeCompare(left.name));
    await Promise.all(
      archives.slice(this.#snapshotKeep).map(({ path }) => rm(path, { force: true })),
    );
  }

  /** Deletes every snapshot belonging to a purged run. */
  async purgeRun(runId: string): Promise<void> {
    const validatedRunId = Id.parse(runId);
    const root = await this.#ensureRoot(this.options.snapshotRoot);
    const path = join(root, validatedRunId);
    const info = await lstat(path).catch((error: unknown) => {
      if (codeOf(error) === "ENOENT") {
        return undefined;
      }
      throw new WorkspaceSnapshotError();
    });
    if (info !== undefined && (!info.isDirectory() || info.isSymbolicLink())) {
      throw new WorkspaceSnapshotError();
    }
    await rm(path, { recursive: true, force: true });
  }

  async #createArchive(runRoot: string): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let size = 0;
    const sink = new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        size += chunk.byteLength;
        if (size > this.#maxSnapshotBytes) {
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

  async #encryptIfConfigured(runId: Id, snapshotId: Id, archive: Buffer): Promise<Buffer> {
    if (!this.#snapshotEncryption) {
      return archive;
    }
    const provider = this.options.keyProvider;
    if (provider === undefined) {
      throw new WorkspaceSnapshotError();
    }
    let key: Buffer | undefined;
    try {
      const keyId = Code.parse(provider.currentKeyId());
      const keyBytes = await provider.getKey(keyId);
      key = Buffer.from(keyBytes);
      const encrypted = aesGcmEncrypt(key, archive, Buffer.from(`${runId}:${snapshotId}`));
      const encodedKeyId = Buffer.from(keyId, "utf8");
      return Buffer.concat([ENCRYPTION_HEADER, Buffer.from([encodedKeyId.byteLength]), encodedKeyId, encrypted]);
    } catch {
      throw new WorkspaceSnapshotError();
    } finally {
      key?.fill(0);
    }
  }

  async #decryptIfEncrypted(runId: Id, snapshotId: Id, storedBytes: Buffer): Promise<Buffer> {
    if (!storedBytes.subarray(0, ENCRYPTION_HEADER.byteLength).equals(ENCRYPTION_HEADER)) {
      return Buffer.from(storedBytes);
    }
    const keyIdLength = storedBytes[ENCRYPTION_HEADER.byteLength];
    if (keyIdLength === undefined || keyIdLength < 1) {
      throw new WorkspaceSnapshotError();
    }
    const keyOffset = ENCRYPTION_HEADER.byteLength + 1;
    const keyId = Code.safeParse(storedBytes.subarray(keyOffset, keyOffset + keyIdLength).toString("utf8"));
    const provider = this.options.keyProvider;
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

  async #extractArchive(archive: Buffer, destination: string): Promise<void> {
    let totalBytes = 0;
    let rootMode: number | undefined;
    let rejection: HarnessError | undefined;
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
        filter: (_path, entry) => {
          if (!("type" in entry)) {
            rejection ??= new UnsafeWorkspaceSnapshotError();
            return false;
          }
          let relativePath: string;
          try {
            relativePath = archiveRelativePath(entry.path);
          } catch {
            rejection ??= new UnsafeWorkspaceSnapshotError();
            return false;
          }
          if (
            entry.type !== "Directory" &&
            entry.type !== "File" &&
            entry.type !== "OldFile"
          ) {
            rejection ??= new UnsafeWorkspaceSnapshotError();
            return false;
          }
          if (entry.type !== "Directory") {
            totalBytes += entry.size;
            if (entry.size > this.#maxFileBytes || totalBytes > this.#maxSnapshotBytes) {
              rejection ??= new SnapshotTooLargeError();
              return false;
            }
          }
          entry.mode = (entry.mode ?? (entry.type === "Directory" ? 0o755 : 0o644)) & 0o777;
          if (relativePath === ".") {
            rootMode = entry.mode;
          }
          return true;
        },
      });
      await pipeline(Readable.from([archive]), extractor);
      if (rejection !== undefined) {
        throw rejection;
      }
      await chmod(destination, rootMode ?? 0o700);
    } catch (error) {
      if (error instanceof HarnessError) {
        throw error;
      }
      throw new WorkspaceSnapshotError();
    }
  }

  async #recoverInterruptedSwap(runRoot: string, oldRoot: string): Promise<void> {
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

  async #ensureRunSnapshotDirectory(runId: Id): Promise<string> {
    const root = await this.#ensureRoot(this.options.snapshotRoot);
    const directory = join(root, runId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await assertPlainDirectory(directory);
    await chmod(directory, 0o700);
    return directory;
  }

  async #ensureRoot(path: string): Promise<string> {
    await mkdir(path, { recursive: true, mode: 0o700 }).catch(() => {
      throw new WorkspaceSnapshotError();
    });
    const info = await lstat(path).catch(() => {
      throw new WorkspaceSnapshotError();
    });
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new WorkspaceSnapshotError();
    }
    return realpath(path).catch(() => {
      throw new WorkspaceSnapshotError();
    });
  }
}
