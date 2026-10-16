// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  chmod,
  open,
  lstat,
  mkdir,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { HarnessError, Id, WorkspaceRef } from "@harness/schemas";
import type { KeyProvider } from "@harness/schemas";
import { ensureRunWorkspace } from "./workspace.js";
import {
  createWorkspaceArchive,
  assertWorkspaceArchiveLimits,
  decryptWorkspaceArchive,
  encryptWorkspaceArchive,
  SnapshotTooLargeError,
  UnsafeWorkspaceSnapshotError,
  WorkspaceSnapshotError,
  restoreWorkspaceArchive,
  workspaceSnapshotRefParts,
} from "./snapshot-archive.js";

const DEFAULT_MAX_SNAPSHOT_BYTES = 1024 * 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const DEFAULT_SNAPSHOT_KEEP = 5;
export { SnapshotTooLargeError, UnsafeWorkspaceSnapshotError, WorkspaceSnapshotError };

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

/** Snapshot operations used by checkpointing and resume. */
export interface WorkspaceSnapshotPort {
  /** Persist the run workspace and return its content-addressed reference. */
  snapshot(runId: string): Promise<WorkspaceRef>;
  /** Replace the run workspace with a verified snapshot. */
  restore(runId: string, ref: WorkspaceRef): Promise<void>;
  /** Check whether the run workspace exists as a real directory. */
  hasWorkspace(runId: string): Promise<boolean>;
  /** Remove stale archives after the matching DB checkpoint has committed. */
  prune(runId: string): Promise<void>;
  /** Remove an unreferenced archive after a failed DB checkpoint append. */
  deleteSnapshot(runId: string, ref: WorkspaceRef): Promise<void>;
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
    const rawTemporaryPath = join(snapshotDirectory, `.${snapshotId}.archive.tmp`);
    const snapshotPath = join(snapshotDirectory, `${snapshotId}.tar.gz`);
    try {
      await assertWorkspaceArchiveLimits(runRoot, this.#maxFileBytes, this.#maxSnapshotBytes);
      const rawPath = this.#snapshotEncryption ? rawTemporaryPath : temporaryPath;
      const digest = createHash("sha256");
      let compressedBytes = 0;
      const compressedLimit = new Transform({
        transform: (chunk: Buffer, _encoding, callback) => {
          compressedBytes += chunk.byteLength;
          if (compressedBytes > this.#maxSnapshotBytes) {
            callback(new SnapshotTooLargeError());
            return;
          }
          if (!this.#snapshotEncryption) {
            digest.update(chunk);
          }
          callback(null, chunk);
        },
      });
      await pipeline(
        await createWorkspaceArchive(runRoot),
        compressedLimit,
        createWriteStream(rawPath, { flags: "wx", mode: 0o600 }),
      );
      if (this.#snapshotEncryption) {
        const archive = await this.#readArchiveBuffer(rawTemporaryPath);
        try {
          const storedBytes = await encryptWorkspaceArchive(archive, {
            runId: validatedRunId,
            snapshotId,
            enabled: true,
            ...(this.options.keyProvider === undefined ? {} : { provider: this.options.keyProvider }),
          });
          if (storedBytes.byteLength > this.#maxSnapshotBytes) {
            storedBytes.fill(0);
            throw new SnapshotTooLargeError();
          }
          digest.update(storedBytes);
          await this.#writeTemporaryArchive(temporaryPath, storedBytes);
          storedBytes.fill(0);
        } finally {
          archive.fill(0);
        }
      }
      await rename(temporaryPath, snapshotPath);
      return WorkspaceRef.parse(`ws:${snapshotId}:${digest.digest("hex").slice(0, 16)}`);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      await rm(rawTemporaryPath, { force: true });
      if (error instanceof HarnessError) {
        throw error;
      }
      throw new WorkspaceSnapshotError();
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
    const workspaceRoot = await this.#ensureRoot(this.options.workspaceRoot);
    const snapshot = await this.#readSnapshot(validatedRunId, WorkspaceRef.parse(ref));
    try {
      await restoreWorkspaceArchive({
        archive: snapshot.archive,
        workspaceRoot,
        runId: validatedRunId,
        temporaryId: Id.parse(this.options.ids.next()),
        maxFileBytes: this.#maxFileBytes,
        maxSnapshotBytes: this.#maxSnapshotBytes,
      });
    } finally {
      snapshot.cleanup();
    }
  }

  async #readSnapshot(
    runId: Id,
    ref: WorkspaceRef,
  ): Promise<{ archive: Readable; cleanup(): void }> {
    const { snapshotId, digest } = workspaceSnapshotRefParts(ref);
    const snapshotDirectory = await this.#ensureRunSnapshotDirectory(runId);
    const snapshotPath = join(snapshotDirectory, `${snapshotId}.tar.gz`);
    const archiveStat = await lstat(snapshotPath).catch(() => {
      throw new WorkspaceSnapshotError();
    });
    if (!archiveStat.isFile() || archiveStat.isSymbolicLink()) {
      throw new WorkspaceSnapshotError();
    }
    if (archiveStat.size > this.#maxSnapshotBytes) {
      throw new SnapshotTooLargeError();
    }
    const header = Buffer.alloc(7);
    const file = await open(snapshotPath, "r").catch(() => {
      throw new WorkspaceSnapshotError();
    });
    let readBytes: number;
    try {
      ({ bytesRead: readBytes } = await file.read(header, 0, header.byteLength, 0));
    } finally {
      await file.close();
    }
    const isEncrypted =
      readBytes === 7 && header.equals(Buffer.from("WSENC01", "ascii"));
    if (isEncrypted) {
      const storedBytes = await this.#readArchiveBuffer(snapshotPath);
      const actualDigest = createHash("sha256").update(storedBytes).digest("hex").slice(0, 16);
      if (actualDigest !== digest) {
        storedBytes.fill(0);
        throw new WorkspaceSnapshotError();
      }
      try {
        const archive = await decryptWorkspaceArchive(
          storedBytes,
          runId,
          snapshotId,
          this.options.keyProvider,
        );
        return {
          archive: Readable.from([archive]),
          cleanup: () => {
            archive.fill(0);
            storedBytes.fill(0);
          },
        };
      } catch (error) {
        storedBytes.fill(0);
        throw error;
      }
    }
    const hash = createHash("sha256");
    let size = 0;
    const verify = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        size += chunk.byteLength;
        hash.update(chunk);
        callback(null, chunk);
      },
      flush: (callback) => {
        if (size > this.#maxSnapshotBytes || hash.digest("hex").slice(0, 16) !== digest) {
          callback(
            size > this.#maxSnapshotBytes
              ? new SnapshotTooLargeError()
              : new WorkspaceSnapshotError(),
          );
          return;
        }
        callback();
      },
    });
    return { archive: createReadStream(snapshotPath).pipe(verify), cleanup: () => verify.destroy() };
  }

  async #readArchiveBuffer(path: string): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of createReadStream(path)) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  async #writeTemporaryArchive(path: string, bytes: Buffer): Promise<void> {
    await pipeline(
      Readable.from([bytes]),
      createWriteStream(path, { flags: "wx", mode: 0o600 }),
    );
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

  /** Removes an archive that was written before a failed checkpoint append. */
  async deleteSnapshot(runId: string, ref: WorkspaceRef): Promise<void> {
    const validatedRunId = Id.parse(runId);
    const { snapshotId } = workspaceSnapshotRefParts(WorkspaceRef.parse(ref));
    const directory = await this.#ensureRunSnapshotDirectory(validatedRunId);
    const path = join(directory, `${snapshotId}.tar.gz`);
    const info = await lstat(path).catch((error: unknown) => {
      if (codeOf(error) === "ENOENT") {
        return undefined;
      }
      throw new WorkspaceSnapshotError();
    });
    if (info !== undefined && (!info.isFile() || info.isSymbolicLink())) {
      throw new WorkspaceSnapshotError();
    }
    await rm(path, { force: true });
  }

  /** Deletes every snapshot belonging to a purged run. */
  async purgeRun(runId: string): Promise<void> {
    return purgeWorkspaceSnapshots(this.options.snapshotRoot, runId);
  }

  async #ensureRunSnapshotDirectory(runId: Id): Promise<string> {
    const root = await this.#ensureRoot(this.options.snapshotRoot);
    await chmod(root, 0o700);
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

/** Deletes all workspace archives associated with one retained run. */
export async function purgeWorkspaceSnapshots(snapshotRoot: string, runId: string): Promise<void> {
  const validatedRunId = Id.parse(runId);
  const rootInfo = await lstat(snapshotRoot).catch((error: unknown) => {
    if (codeOf(error) === "ENOENT") {
      return undefined;
    }
    throw new WorkspaceSnapshotError();
  });
  if (rootInfo === undefined) {
    return;
  }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new WorkspaceSnapshotError();
  }
  const root = await realpath(snapshotRoot).catch(() => {
    throw new WorkspaceSnapshotError();
  });
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
