// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Id } from "@rovinos/schemas";
import { afterEach, describe, expect, it } from "vitest";
import { readVerifiedPlainArchive } from "./snapshot-reader.js";

const runSnapshotId = Id.parse("00000000000000000000000002");
const directories: string[] = [];

async function createDirectory(): Promise<string> {
  const directory = await mkdtemp(join(process.cwd(), ".tmp", "snapshot-reader-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("verified workspace snapshot reader", () => {
  it("copies and verifies the archive before exposing a readable stream", async () => {
    const directory = await createDirectory();
    const archive = Buffer.from("synthetic archive");
    const archivePath = join(directory, "snapshot.tar.gz");
    await writeFile(archivePath, archive);

    const verified = await readVerifiedPlainArchive({
      snapshotPath: archivePath,
      snapshotDirectory: directory,
      snapshotId: runSnapshotId,
      digest: createHash("sha256").update(archive).digest("hex").slice(0, 16),
      maxSnapshotBytes: archive.byteLength,
    });
    const chunks: Buffer[] = [];
    for await (const chunk of verified.archive) {
      chunks.push(Buffer.from(chunk));
    }

    expect(Buffer.concat(chunks)).toEqual(archive);
    await verified.cleanup();
  });

  it("rejects unavailable paths, oversized archives, and digest mismatches", async () => {
    const directory = await createDirectory();
    const archivePath = join(directory, "snapshot.tar.gz");
    await writeFile(archivePath, Buffer.from("oversized"));

    await expect(
      readVerifiedPlainArchive({
        snapshotPath: archivePath,
        snapshotDirectory: join(directory, "missing"),
        snapshotId: runSnapshotId,
        digest: "0".repeat(16),
        maxSnapshotBytes: 64,
      }),
    ).rejects.toMatchObject({ code: "workspace_snapshot_invalid" });
    await expect(
      readVerifiedPlainArchive({
        snapshotPath: archivePath,
        snapshotDirectory: directory,
        snapshotId: runSnapshotId,
        digest: "0".repeat(16),
        maxSnapshotBytes: 2,
      }),
    ).rejects.toMatchObject({ code: "snapshot_too_large" });
    await expect(
      readVerifiedPlainArchive({
        snapshotPath: archivePath,
        snapshotDirectory: directory,
        snapshotId: runSnapshotId,
        digest: "0".repeat(16),
        maxSnapshotBytes: 64,
      }),
    ).rejects.toMatchObject({ code: "workspace_snapshot_invalid" });
  });
});
