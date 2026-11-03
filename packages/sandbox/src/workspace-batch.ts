// SPDX-License-Identifier: Apache-2.0
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { lstat, open, rename, unlink } from "node:fs/promises";
import { WorkspacePathError } from "@rovinos/context";

interface WorkspaceBatchEntry {
  readonly path: string;
  readonly data: Uint8Array;
}

function codeOf(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

/** Stages and publishes a batch of workspace files, removing partial writes on failure. */
export async function publishWorkspaceBatch(
  entries: readonly WorkspaceBatchEntry[],
  resolveOffloadPath: (path: string) => Promise<string>,
): Promise<readonly string[]> {
  const staged: { readonly temporary: string; readonly target: string }[] = [];
  const published: string[] = [];
  try {
    for (const [index, entry] of entries.entries()) {
      const target = await resolveOffloadPath(entry.path);
      const temporary = await resolveOffloadPath(
        `.harness/offload/.batch-${randomUUID()}-${index.toString()}`,
      );
      try {
        await lstat(target);
        throw new WorkspacePathError();
      } catch (error) {
        if (error instanceof WorkspacePathError) {
          throw error;
        }
        if (codeOf(error) !== "ENOENT") {
          throw new WorkspacePathError();
        }
      }
      const handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      ).catch(() => {
        throw new WorkspacePathError();
      });
      staged.push({ temporary, target });
      try {
        await handle.writeFile(entry.data);
      } finally {
        await handle.close();
      }
    }
    for (const { temporary, target } of staged) {
      await rename(temporary, target);
      published.push(target);
    }
    return published;
  } catch (error) {
    await Promise.allSettled(staged.map(({ temporary }) => unlink(temporary)));
    await Promise.allSettled(published.map((path) => unlink(path)));
    if (error instanceof WorkspacePathError) {
      throw error;
    }
    throw new WorkspacePathError();
  }
}
