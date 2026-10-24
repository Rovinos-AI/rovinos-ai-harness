// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Transform } from "node:stream";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { HarnessError } from "@rovinos/schemas";
import type { Id } from "@rovinos/schemas";
import { SnapshotTooLargeError, WorkspaceSnapshotError } from "./snapshot-archive.js";

/** Verifies stored bytes before exposing the streamed archive to an extractor. */
export async function readVerifiedPlainArchive(options: {
  readonly snapshotPath: string;
  readonly snapshotDirectory: string;
  readonly snapshotId: Id;
  readonly digest: string;
  readonly maxSnapshotBytes: number;
}): Promise<{ archive: Readable; cleanup(): Promise<void> }> {
  const { snapshotPath, snapshotDirectory, snapshotId, digest, maxSnapshotBytes } = options;
  const verifiedDirectory = await mkdtemp(join(snapshotDirectory, `.${snapshotId}.restore-`)).catch(
    () => {
      throw new WorkspaceSnapshotError();
    },
  );
  const verifiedPath = join(verifiedDirectory, "archive");
  const hash = createHash("sha256");
  let size = 0;
  const verify = new Transform({
    transform: (chunk: Buffer, _encoding, callback) => {
      size += chunk.byteLength;
      if (size > maxSnapshotBytes) {
        callback(new SnapshotTooLargeError());
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(
      createReadStream(snapshotPath),
      verify,
      createWriteStream(verifiedPath, { flags: "wx", mode: 0o600 }),
    );
    if (hash.digest("hex").slice(0, 16) !== digest) {
      throw new WorkspaceSnapshotError();
    }
    const archive = createReadStream(verifiedPath);
    return {
      archive,
      cleanup: async () => {
        archive.destroy();
        await rm(verifiedDirectory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(verifiedDirectory, { recursive: true, force: true });
    if (error instanceof HarnessError) {
      throw error;
    }
    throw new WorkspaceSnapshotError();
  }
}
