// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Id, type KeyProvider, type WorkspaceRef } from "@harness/schemas";
import { afterEach, describe, expect, it } from "vitest";
import {
  SnapshotTooLargeError,
  WorkspaceSnapshotError,
  WorkspaceSnapshotter,
} from "./snapshot.js";

const runId = Id.parse("00000000000000000000000001");
const snapshotId = Id.parse("00000000000000000000000002");
const roots: string[] = [];

async function createRoots(): Promise<{ workspaceRoot: string; snapshotRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), "workspace-snapshot-"));
  roots.push(root);
  const workspaceRoot = join(root, "workspaces");
  const snapshotRoot = join(root, "snapshots");
  await mkdir(workspaceRoot);
  await mkdir(snapshotRoot);
  return { workspaceRoot, snapshotRoot };
}

function ids(...values: string[]): { next(): string } {
  let index = 0;
  return {
    next: () => {
      const value = values[index];
      index += 1;
      if (value === undefined) {
        throw new Error("No test ID remains.");
      }
      return value;
    },
  };
}

function snapshotter(
  rootsToUse: { workspaceRoot: string; snapshotRoot: string },
  options: {
    readonly maxSnapshotBytes?: number;
    readonly maxFileBytes?: number;
    readonly snapshotKeep?: number;
    readonly snapshotEncryption?: boolean;
    readonly keyProvider?: KeyProvider;
    readonly ids?: { next(): string };
  } = {},
): WorkspaceSnapshotter {
  return new WorkspaceSnapshotter({
    ...rootsToUse,
    ids: options.ids ?? ids(snapshotId, "00000000000000000000000003"),
    ...options,
  });
}

function tarEntry(
  name: string,
  type: string,
  data: Buffer = Buffer.alloc(0),
  linkname = "",
): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000755\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(`${data.byteLength.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1, "ascii");
  header.write(linkname, 157, 100, "utf8");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  let checksum = 0;
  for (const byte of header) {
    checksum += byte;
  }
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  const padding = Buffer.alloc((512 - (data.byteLength % 512)) % 512);
  return Buffer.concat([header, data, padding]);
}

function maliciousArchive(
  name: string,
  type: string,
  data: Buffer = Buffer.alloc(0),
  linkname = "",
): Buffer {
  return gzipSync(Buffer.concat([tarEntry(name, type, data, linkname), Buffer.alloc(1024)]));
}

async function writeArchive(
  rootsToUse: { workspaceRoot: string; snapshotRoot: string },
  bytes: Buffer,
): Promise<WorkspaceRef> {
  const directory = join(rootsToUse.snapshotRoot, runId);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${snapshotId}.tar.gz`), bytes);
  const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  return `ws:${snapshotId}:${digest}`;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("WorkspaceSnapshotter", () => {
  it("round-trips files and modes while excluding per-run scratch", async () => {
    const paths = await createRoots();
    const runRoot = join(paths.workspaceRoot, runId);
    await mkdir(join(runRoot, "project"), { recursive: true });
    await mkdir(join(runRoot, ".harness", "tmp"), { recursive: true });
    await writeFile(join(runRoot, "project", "file.txt"), "snapshot content");
    await writeFile(join(runRoot, ".harness", "tmp", "ignored.txt"), "scratch");
    await chmod(join(runRoot, "project", "file.txt"), 0o4750);
    const snapshotterInstance = snapshotter(paths);
    const ref = await snapshotterInstance.snapshot(runId);
    await writeFile(join(runRoot, "project", "file.txt"), "changed");
    await snapshotterInstance.restore(runId, ref);

    expect(await readFile(join(runRoot, "project", "file.txt"), "utf8")).toBe("snapshot content");
    expect((await stat(join(runRoot, "project", "file.txt"))).mode & 0o7777).toBe(0o750);
    await expect(readFile(join(runRoot, ".harness", "tmp", "ignored.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(snapshotterInstance.hasWorkspace(runId)).resolves.toBe(true);
  });

  it("rejects snapshots and restores that exceed the configured limits", async () => {
    const paths = await createRoots();
    const runRoot = join(paths.workspaceRoot, runId);
    await mkdir(runRoot, { recursive: true });
    await writeFile(join(runRoot, "large"), Buffer.alloc(512, 1));
    const smallArchiveLimit = snapshotter(paths, { maxSnapshotBytes: 32 });
    await expect(smallArchiveLimit.snapshot(runId)).rejects.toBeInstanceOf(SnapshotTooLargeError);

    const ref = await writeArchive(paths, maliciousArchive("large", "0", Buffer.alloc(20)));
    const smallFileLimit = snapshotter(paths, { maxFileBytes: 10 });
    await expect(smallFileLimit.restore(runId, ref)).rejects.toBeInstanceOf(SnapshotTooLargeError);
    await expect(readFile(join(runRoot, "large"))).resolves.toEqual(Buffer.alloc(512, 1));
  });

  it("rejects a tampered archive before changing the workspace", async () => {
    const paths = await createRoots();
    const runRoot = join(paths.workspaceRoot, runId);
    await mkdir(runRoot, { recursive: true });
    await writeFile(join(runRoot, "keep"), "original");
    const ref = await writeArchive(paths, maliciousArchive("new", "0", Buffer.from("archive")));
    await writeFile(join(paths.snapshotRoot, runId, `${snapshotId}.tar.gz`), "tampered");

    await expect(snapshotter(paths).restore(runId, ref)).rejects.toBeInstanceOf(WorkspaceSnapshotError);
    await expect(readFile(join(runRoot, "keep"), "utf8")).resolves.toBe("original");
  });

  it.each([
    ["traversal", "../escaped", "0", Buffer.from("bad")],
    ["absolute path", "/escaped", "0", Buffer.from("bad")],
    ["symlink escape", "link", "2", Buffer.alloc(0), "../escaped"],
    ["hardlink escape", "link", "1", Buffer.alloc(0), "../escaped"],
    ["device node", "device", "3"],
    ["FIFO", "pipe", "6"],
  ])("rejects %s archives without changing the existing workspace", async (_name, path, type, data, link) => {
    // threat: T-17
    const paths = await createRoots();
    const runRoot = join(paths.workspaceRoot, runId);
    await mkdir(runRoot, { recursive: true });
    await writeFile(join(runRoot, "keep"), "original");
    const ref = await writeArchive(
      paths,
      maliciousArchive(path, type, data, link),
    );

    await expect(snapshotter(paths).restore(runId, ref)).rejects.toBeInstanceOf(Error);
    await expect(readFile(join(runRoot, "keep"), "utf8")).resolves.toBe("original");
    await expect(readFile(join(paths.workspaceRoot, "escaped"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps the original workspace if extraction fails after accepting an earlier file", async () => {
    // threat: T-17
    const paths = await createRoots();
    const runRoot = join(paths.workspaceRoot, runId);
    await mkdir(runRoot, { recursive: true });
    await writeFile(join(runRoot, "keep"), "original");
    const archive = gzipSync(
      Buffer.concat([
        tarEntry("first", "0", Buffer.from("partial")),
        tarEntry("../escaped", "0", Buffer.from("bad")),
        Buffer.alloc(1024),
      ]),
    );
    const ref = await writeArchive(paths, archive);

    await expect(snapshotter(paths).restore(runId, ref)).rejects.toBeInstanceOf(Error);
    await expect(readFile(join(runRoot, "keep"), "utf8")).resolves.toBe("original");
    await expect(readFile(join(paths.workspaceRoot, "escaped"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("encrypts snapshots with AES-GCM and decrypts them on restore", async () => {
    const paths = await createRoots();
    const runRoot = join(paths.workspaceRoot, runId);
    await mkdir(runRoot, { recursive: true });
    await writeFile(join(runRoot, "secret.txt"), "synthetic workspace content");
    const key = Buffer.alloc(32, 7);
    const provider: KeyProvider = {
      currentKeyId: () => "test_key",
      getKey: () => Promise.resolve(key),
    };
    const snapshotterInstance = snapshotter(paths, {
      ids: ids(snapshotId, "00000000000000000000000003"),
      snapshotEncryption: true,
      keyProvider: provider,
    });
    const ref = await snapshotterInstance.snapshot(runId);
    const archivePath = join(paths.snapshotRoot, runId, `${snapshotId}.tar.gz`);
    expect((await readFile(archivePath)).includes(Buffer.from("synthetic workspace content"))).toBe(
      false,
    );
    await rm(runRoot, { recursive: true });
    await snapshotterInstance.restore(runId, ref);
    await expect(readFile(join(runRoot, "secret.txt"), "utf8")).resolves.toBe(
      "synthetic workspace content",
    );
    expect(key).toEqual(Buffer.alloc(32, 7));
  });

  it("prunes old archives and deletes all archives when a run is purged", async () => {
    const paths = await createRoots();
    const runRoot = join(paths.workspaceRoot, runId);
    await mkdir(runRoot, { recursive: true });
    await writeFile(join(runRoot, "file"), "value");
    const first = snapshotId;
    const second = Id.parse("00000000000000000000000003");
    const instance = snapshotter(paths, {
      ids: ids(first, second),
      snapshotKeep: 1,
    });
    await instance.snapshot(runId);
    await instance.snapshot(runId);
    await instance.prune(runId);

    const directory = join(paths.snapshotRoot, runId);
    await expect(readdir(directory)).resolves.toEqual([`${second}.tar.gz`]);
    await instance.purgeRun(runId);
    await expect(readdir(directory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(instance.hasWorkspace(runId)).resolves.toBe(true);
  });

  it("rejects invalid configuration and missing encryption keys", async () => {
    const paths = await createRoots();
    expect(() => snapshotter(paths, { maxSnapshotBytes: 0 })).toThrow(RangeError);
    expect(() => snapshotter(paths, { snapshotEncryption: true })).toThrow(
      WorkspaceSnapshotError,
    );
  });
});
