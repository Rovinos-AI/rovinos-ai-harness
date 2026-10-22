// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, open, lstat, mkdir, realpath, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { HarnessError, Id, WorkspaceRef } from "@harness/schemas";
import type { KeyProvider } from "@harness/schemas";
import { ensureRunWorkspace } from "./workspace.js";
import { createEmptyWorkspaceArchive } from "./snapshot-empty.js";
import {
  createWorkspaceArchive,
  assertWorkspaceArchiveLimits,
  SnapshotTooLargeError,
  UnsafeWorkspaceSnapshotError,
  WorkspaceSnapshotError,
  workspaceSnapshotRefParts,
} from "./snapshot-archive.js";
import { decryptWorkspaceArchive, encryptWorkspaceArchive } from "./snapshot-encryption.js";
import { purgeWorkspaceSnapshots, WorkspaceSnapshotRetention } from "./snapshot-retention.js";
import { readVerifiedPlainArchive } from "./snapshot-reader.js";
import { restoreWorkspaceArchive } from "./snapshot-restore.js";

const DEFAULT_MAX_SNAPSHOT_BYTES = 1024 * 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const DEFAULT_SNAPSHOT_KEEP = 5;
export { SnapshotTooLargeError, UnsafeWorkspaceSnapshotError, WorkspaceSnapshotError };
export { purgeWorkspaceSnapshots };

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
  /** Workspace access hosted by a remote sandbox runner. */
  readonly remoteWorkspace?: RemoteWorkspaceSnapshotPort;
}

/** Streaming access to the workspace mounted inside a remote sandbox runner. */
export interface RemoteWorkspaceSnapshotPort {
  createArchive(runId: Id, maxFileBytes: number, maxSnapshotBytes: number): Promise<Readable>;
  restoreArchive(
    runId: Id,
    archive: Readable,
    maxFileBytes: number,
    maxSnapshotBytes: number,
  ): Promise<void>;
  hasWorkspace(runId: Id): Promise<boolean>;
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
  prune(runId: string, retainedRefs: readonly WorkspaceRef[]): Promise<void>;
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
  readonly #snapshotEncryption: boolean;
  readonly #retention: WorkspaceSnapshotRetention;

  constructor(private readonly options: WorkspaceSnapshotterOptions) {
    this.#maxSnapshotBytes = options.maxSnapshotBytes ?? DEFAULT_MAX_SNAPSHOT_BYTES;
    this.#maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    const snapshotKeep = options.snapshotKeep ?? DEFAULT_SNAPSHOT_KEEP;
    this.#snapshotEncryption = options.snapshotEncryption ?? false;
    if (
      !Number.isSafeInteger(this.#maxSnapshotBytes) ||
      this.#maxSnapshotBytes < 1 ||
      !Number.isSafeInteger(this.#maxFileBytes) ||
      this.#maxFileBytes < 1 ||
      !Number.isSafeInteger(snapshotKeep) ||
      snapshotKeep < 1
    ) {
      throw new RangeError("Workspace snapshot limits must be positive safe integers.");
    }
    if (this.#snapshotEncryption && options.keyProvider === undefined) {
      throw new WorkspaceSnapshotError();
    }
    this.#retention = new WorkspaceSnapshotRetention(options.snapshotRoot, snapshotKeep, (runId) =>
      this.#ensureRunSnapshotDirectory(runId),
    );
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
    const snapshotDirectory = await this.#ensureRunSnapshotDirectory(validatedRunId);
    const temporaryPath = join(snapshotDirectory, `.${snapshotId}.tmp`);
    const rawTemporaryPath = join(snapshotDirectory, `.${snapshotId}.archive.tmp`);
    const snapshotPath = join(snapshotDirectory, `${snapshotId}.tar.gz`);
    try {
      const archive = await this.#createArchiveSource(validatedRunId);
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
        archive,
        compressedLimit,
        createWriteStream(rawPath, { flags: "wx", mode: 0o600 }),
      );
      if (this.#snapshotEncryption) {
        const archiveBytes = await this.#readArchiveBuffer(rawTemporaryPath);
        try {
          const storedBytes = await encryptWorkspaceArchive(archiveBytes, {
            runId: validatedRunId,
            snapshotId,
            enabled: true,
            ...(this.options.keyProvider === undefined
              ? {}
              : { provider: this.options.keyProvider }),
          });
          if (storedBytes.byteLength > this.#maxSnapshotBytes) {
            storedBytes.fill(0);
            throw new SnapshotTooLargeError();
          }
          digest.update(storedBytes);
          await this.#writeTemporaryArchive(temporaryPath, storedBytes);
          storedBytes.fill(0);
        } finally {
          archiveBytes.fill(0);
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
    const snapshot = await this.#readSnapshot(validatedRunId, WorkspaceRef.parse(ref));
    try {
      if (this.options.remoteWorkspace !== undefined) {
        await this.options.remoteWorkspace.restoreArchive(
          validatedRunId,
          snapshot.archive,
          this.#maxFileBytes,
          this.#maxSnapshotBytes,
        );
      } else {
        await restoreWorkspaceArchive({
          archive: snapshot.archive,
          workspaceRoot: await this.#ensureRoot(this.options.workspaceRoot),
          runId: validatedRunId,
          temporaryId: Id.parse(this.options.ids.next()),
          maxFileBytes: this.#maxFileBytes,
          maxSnapshotBytes: this.#maxSnapshotBytes,
        });
      }
    } finally {
      await snapshot.cleanup();
    }
  }

  async #readSnapshot(
    runId: Id,
    ref: WorkspaceRef,
  ): Promise<{ archive: Readable; cleanup(): void | Promise<void> }> {
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
    const isEncrypted = readBytes === 7 && header.equals(Buffer.from("WSENC01", "ascii"));
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
    return readVerifiedPlainArchive({
      snapshotPath,
      snapshotDirectory,
      snapshotId,
      digest,
      maxSnapshotBytes: this.#maxSnapshotBytes,
    });
  }

  async #readArchiveBuffer(path: string): Promise<Buffer> {
    const chunks: Uint8Array[] = [];
    const source: AsyncIterable<Buffer> = createReadStream(path);
    for await (const chunk of source) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  async #writeTemporaryArchive(path: string, bytes: Buffer): Promise<void> {
    await pipeline(Readable.from([bytes]), createWriteStream(path, { flags: "wx", mode: 0o600 }));
  }

  /** Returns whether a non-symlink run workspace currently exists. */
  async hasWorkspace(runId: string): Promise<boolean> {
    const validatedRunId = Id.parse(runId);
    if (this.options.remoteWorkspace !== undefined) {
      return this.options.remoteWorkspace.hasWorkspace(validatedRunId);
    }
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

  async #createArchiveSource(runId: Id): Promise<Readable> {
    if (this.options.remoteWorkspace !== undefined) {
      if (!(await this.options.remoteWorkspace.hasWorkspace(runId))) {
        return createEmptyWorkspaceArchive(runId);
      }
      return this.options.remoteWorkspace.createArchive(
        runId,
        this.#maxFileBytes,
        this.#maxSnapshotBytes,
      );
    }
    const workspaceRoot = await this.#ensureRoot(this.options.workspaceRoot);
    const runRoot = join(workspaceRoot, runId);
    await ensureRunWorkspace(workspaceRoot, runId);
    await assertPlainDirectory(runRoot);
    await assertWorkspaceArchiveLimits(runRoot, this.#maxFileBytes, this.#maxSnapshotBytes);
    return createWorkspaceArchive(runRoot);
  }

  /** Removes archives whose refs are no longer retained by the event store. */
  prune(runId: string, retainedRefs: readonly WorkspaceRef[]): Promise<void> {
    return this.#retention.prune(runId, retainedRefs);
  }

  /** Removes an archive that was written before a failed checkpoint append. */
  deleteSnapshot(runId: string, ref: WorkspaceRef): Promise<void> {
    return this.#retention.deleteSnapshot(runId, ref);
  }

  /** Deletes every snapshot belonging to a purged run. */
  purgeRun(runId: string): Promise<void> {
    return this.#retention.purgeRun(runId);
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
