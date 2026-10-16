// SPDX-License-Identifier: Apache-2.0
import { lstat, mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { HarnessError } from "@harness/schemas";
import type { Id } from "@harness/schemas";
import { extractWorkspaceArchive, WorkspaceSnapshotError } from "./snapshot-archive.js";

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
  readonly archive: Buffer | Readable;
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
