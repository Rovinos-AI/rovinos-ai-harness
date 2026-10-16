// SPDX-License-Identifier: Apache-2.0
import { createHash, randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import {
  chmod,
  link,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Id, WorkspaceRef, type KeyProvider } from "@harness/schemas";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SnapshotTooLargeError,
  WorkspaceSnapshotError,
  WorkspaceSnapshotter,
  purgeWorkspaceSnapshots,
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

function archiveOf(...entries: Buffer[]): Buffer {
  return gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
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

function snapshotIdFrom(ref: WorkspaceRef): string {
  const snapshot = ref.split(":")[1];
  if (snapshot === undefined) {
    throw new Error("The snapshot reference has no ID.");
  }
  return snapshot;
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
    expect((await stat(paths.snapshotRoot)).mode & 0o777).toBe(0o700);
    expect((await stat(join(paths.snapshotRoot, runId, `${snapshotId}.tar.gz`))).mode & 0o777).toBe(
      0o600,
    );
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

  it("enforces file and uncompressed limits before publishing a snapshot", async () => {
    const paths = await createRoots();
    const runRoot = join(paths.workspaceRoot, runId);
    await mkdir(runRoot, { recursive: true });
    await writeFile(join(runRoot, "large"), Buffer.alloc(11 * 1024 * 1024, 1));

    await expect(
      snapshotter(paths, {
        maxFileBytes: 10 * 1024 * 1024,
        maxSnapshotBytes: 12 * 1024 * 1024,
      }).snapshot(runId),
    ).rejects.toBeInstanceOf(SnapshotTooLargeError);
    await expect(readdir(join(paths.snapshotRoot, runId))).resolves.toEqual([]);
  });

  it("restores every snapshot accepted by its configured file and total limits", async () => {
    const paths = await createRoots();
    const runRoot = join(paths.workspaceRoot, runId);
    await mkdir(runRoot, { recursive: true });
    const content = randomBytes(8192);
    await writeFile(join(runRoot, "small"), content);
    const first = snapshotter(paths, { maxFileBytes: content.byteLength });
    await first.snapshot(runId);
    const archivePath = join(paths.snapshotRoot, runId, `${snapshotId}.tar.gz`);
    const compressedBytes = (await stat(archivePath)).size;
    const exactBound = snapshotter(paths, {
      ids: ids("00000000000000000000000003", "00000000000000000000000004"),
      maxFileBytes: content.byteLength,
      maxSnapshotBytes: compressedBytes + 1,
    });
    const ref = await exactBound.snapshot(runId);
    expect(
      (await stat(join(paths.snapshotRoot, runId, "00000000000000000000000003.tar.gz"))).size,
    ).toBe(compressedBytes);
    await rm(runRoot, { recursive: true });

    await expect(exactBound.restore(runId, ref)).resolves.toBeUndefined();
    await expect(readFile(join(runRoot, "small"))).resolves.toEqual(content);
  });

  it("streams archive creation without concatenating its contents into a full buffer", async () => {
    const paths = await createRoots();
    const runRoot = join(paths.workspaceRoot, runId);
    await mkdir(runRoot, { recursive: true });
    await writeFile(join(runRoot, "large"), Buffer.alloc(1024 * 1024, 1));
    const concat = vi.spyOn(Buffer, "concat");

    try {
      await expect(snapshotter(paths).snapshot(runId)).resolves.toMatch(/^ws:/u);
      expect(concat).not.toHaveBeenCalled();
    } finally {
      concat.mockRestore();
    }
  });

  it("rejects missing and oversized snapshot files before extraction", async () => {
    const paths = await createRoots();
    const ref = WorkspaceRef.parse(`ws:${snapshotId}:0000000000000000`);
    await expect(snapshotter(paths).restore(runId, ref)).rejects.toBeInstanceOf(
      WorkspaceSnapshotError,
    );

    const oversized = await writeArchive(paths, Buffer.alloc(64, 1));
    await expect(
      snapshotter(paths, { maxSnapshotBytes: 16 }).restore(runId, oversized),
    ).rejects.toBeInstanceOf(SnapshotTooLargeError);
  });

  it("preserves a pre-existing restore temporary directory on an ID collision", async () => {
    const paths = await createRoots();
    const runRoot = join(paths.workspaceRoot, runId);
    await mkdir(runRoot);
    await writeFile(join(runRoot, "keep"), "original");
    const instance = snapshotter(paths);
    const ref = await instance.snapshot(runId);
    const collisionRoot = join(paths.workspaceRoot, `.${runId}.restore-00000000000000000000000003`);
    await mkdir(collisionRoot);
    await writeFile(join(collisionRoot, "keep"), "do not remove");

    await expect(instance.restore(runId, ref)).rejects.toBeInstanceOf(WorkspaceSnapshotError);
    await expect(readFile(join(collisionRoot, "keep"), "utf8")).resolves.toBe("do not remove");
    await expect(readFile(join(runRoot, "keep"), "utf8")).resolves.toBe("original");
  });

  it("recovers an interrupted directory swap before restoring", async () => {
    const paths = await createRoots();
    const runRoot = join(paths.workspaceRoot, runId);
    const oldRoot = join(paths.workspaceRoot, `${runId}.old`);
    await mkdir(runRoot);
    await writeFile(join(runRoot, "keep"), "checkpointed");
    const instance = snapshotter(paths);
    const ref = await instance.snapshot(runId);
    await rm(runRoot, { recursive: true });
    await mkdir(oldRoot);
    await writeFile(join(oldRoot, "interrupted"), "old workspace");

    await instance.restore(runId, ref);

    await expect(readFile(join(runRoot, "keep"), "utf8")).resolves.toBe("checkpointed");
    await expect(readFile(join(runRoot, "interrupted"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to restore over or report a symlink workspace", async () => {
    const paths = await createRoots();
    const outside = join(paths.workspaceRoot, "outside");
    const runRoot = join(paths.workspaceRoot, runId);
    await mkdir(outside);
    await symlink(outside, runRoot, "dir");
    const ref = await writeArchive(paths, maliciousArchive("file", "0", Buffer.from("new")));

    await expect(snapshotter(paths).restore(runId, ref)).rejects.toBeInstanceOf(
      WorkspaceSnapshotError,
    );
    await expect(snapshotter(paths).hasWorkspace(runId)).rejects.toBeInstanceOf(
      WorkspaceSnapshotError,
    );
    await expect(readdir(outside)).resolves.toEqual([]);
  });

  it("removes a temporary archive if the atomic snapshot rename fails", async () => {
    const paths = await createRoots();
    const runRoot = join(paths.workspaceRoot, runId);
    await mkdir(runRoot, { recursive: true });
    await writeFile(join(runRoot, "file"), "value");
    await mkdir(join(paths.snapshotRoot, runId, `${snapshotId}.tar.gz`), { recursive: true });

    await expect(snapshotter(paths).snapshot(runId)).rejects.toBeInstanceOf(WorkspaceSnapshotError);
    await expect(readdir(join(paths.snapshotRoot, runId))).resolves.toEqual([
      `${snapshotId}.tar.gz`,
    ]);
  });

  it("rejects a tampered archive before changing the workspace", async () => {
    const paths = await createRoots();
    const runRoot = join(paths.workspaceRoot, runId);
    await mkdir(runRoot, { recursive: true });
    await writeFile(join(runRoot, "keep"), "original");
    const ref = await writeArchive(paths, maliciousArchive("new", "0", Buffer.from("archive")));
    await writeFile(join(paths.snapshotRoot, runId, `${snapshotId}.tar.gz`), "tampered");

    await expect(snapshotter(paths).restore(runId, ref)).rejects.toBeInstanceOf(
      WorkspaceSnapshotError,
    );
    await expect(readFile(join(runRoot, "keep"), "utf8")).resolves.toBe("original");
    const instance = snapshotter(paths);
    await instance.deleteSnapshot(runId, ref);
    await instance.deleteSnapshot(runId, ref);
  });

  it("rejects workspace references that do not contain a snapshot id and digest", async () => {
    const paths = await createRoots();
    const ref = WorkspaceRef.parse("ws:invalid:0000000000000000");

    await expect(snapshotter(paths).restore(runId, ref)).rejects.toBeInstanceOf(
      WorkspaceSnapshotError,
    );
  });

  it.each([
    ["traversal", "../escaped", "0", Buffer.from("bad")],
    ["absolute path", "__absolute__", "0", Buffer.from("bad")],
    ["symlink escape", "link", "2", Buffer.alloc(0), "../escaped"],
    ["hardlink escape", "link", "1", Buffer.alloc(0), "../escaped"],
    ["device node", "device", "3"],
    ["FIFO", "pipe", "6"],
  ])(
    "rejects %s archives without changing the existing workspace",
    async (_name, path, type, data?: Buffer, linkTarget?: string) => {
      // threat: T-17
      const paths = await createRoots();
      const runRoot = join(paths.workspaceRoot, runId);
      await mkdir(runRoot, { recursive: true });
      await writeFile(join(runRoot, "keep"), "original");
      const outsideAbsolutePath = join(paths.workspaceRoot, "..", "absolute-escaped");
      const archivePath = path === "__absolute__" ? outsideAbsolutePath : path;
      const ref = await writeArchive(paths, maliciousArchive(archivePath, type, data, linkTarget));

      await expect(snapshotter(paths).restore(runId, ref)).rejects.toBeInstanceOf(Error);
      await expect(readFile(join(runRoot, "keep"), "utf8")).resolves.toBe("original");
      await expect(readFile(join(paths.workspaceRoot, "escaped"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(readFile(outsideAbsolutePath)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.each([
    [
      "sub/link -> .. followed by x -> sub/link/..",
      [
        tarEntry("sub/link", "2", Buffer.alloc(0), ".."),
        tarEntry("x", "2", Buffer.alloc(0), "sub/link/.."),
        Buffer.alloc(1024),
      ],
    ],
    [
      "a -> . followed by b -> a/..",
      [
        tarEntry("a", "2", Buffer.alloc(0), "."),
        tarEntry("b", "2", Buffer.alloc(0), "a/.."),
        Buffer.alloc(1024),
      ],
    ],
    [
      "x -> sub/link/.. followed by sub/link -> ..",
      [
        tarEntry("x", "2", Buffer.alloc(0), "sub/link/.."),
        tarEntry("sub/link", "2", Buffer.alloc(0), ".."),
        Buffer.alloc(1024),
      ],
    ],
    [
      "b -> a/.. followed by a -> .",
      [
        tarEntry("b", "2", Buffer.alloc(0), "a/.."),
        tarEntry("a", "2", Buffer.alloc(0), "."),
        Buffer.alloc(1024),
      ],
    ],
  ])("rejects chained symlink escape: %s", async (_description, entries) => {
    // threat: T-17
    const paths = await createRoots();
    const runRoot = join(paths.workspaceRoot, runId);
    await mkdir(runRoot, { recursive: true });
    await writeFile(join(runRoot, "keep"), "original");
    const ref = await writeArchive(paths, gzipSync(Buffer.concat(entries)));

    await expect(snapshotter(paths).restore(runId, ref)).rejects.toMatchObject({
      code: "workspace_snapshot_unsafe",
    });
    await expect(readFile(join(runRoot, "keep"), "utf8")).resolves.toBe("original");
    await expect(readdir(runRoot)).resolves.toEqual(["keep"]);
  });

  it("rejects a hardlink whose target has not already been accepted", async () => {
    // threat: T-17
    const paths = await createRoots();
    const runRoot = join(paths.workspaceRoot, runId);
    await mkdir(runRoot, { recursive: true });
    await writeFile(join(runRoot, "keep"), "original");
    const ref = await writeArchive(paths, maliciousArchive("link", "1", Buffer.alloc(0), "later"));

    await expect(snapshotter(paths).restore(runId, ref)).rejects.toMatchObject({
      code: "workspace_snapshot_unsafe",
    });
    await expect(readFile(join(runRoot, "keep"), "utf8")).resolves.toBe("original");
  });

  it("round-trips contained relative symbolic and hard links", async () => {
    // threat: T-17
    const paths = await createRoots();
    const runRoot = join(paths.workspaceRoot, runId);
    await mkdir(join(runRoot, "project"), { recursive: true });
    await writeFile(join(runRoot, "project", "v2"), "symbolic target");
    await symlink("v2", join(runRoot, "project", "current"));
    await writeFile(join(runRoot, "project", "original"), "hardlink target");
    await link(join(runRoot, "project", "original"), join(runRoot, "project", "copy"));
    const instance = snapshotter(paths);
    const ref = await instance.snapshot(runId);
    await rm(runRoot, { recursive: true });

    await instance.restore(runId, ref);

    await expect(readFile(join(runRoot, "project", "current"), "utf8")).resolves.toBe(
      "symbolic target",
    );
    await expect(
      lstat(join(runRoot, "project", "current")).then((info) => info.isSymbolicLink()),
    ).resolves.toBe(true);
    await expect(readFile(join(runRoot, "project", "copy"), "utf8")).resolves.toBe(
      "hardlink target",
    );
    await expect(
      lstat(join(runRoot, "project", "original")).then((original) =>
        lstat(join(runRoot, "project", "copy")).then((copy) => original.ino === copy.ino),
      ),
    ).resolves.toBe(true);
  });

  it.each([
    ["escaping relative symlink", "link", "2", Buffer.alloc(0), "../x"],
    ["absolute symlink", "link", "2", Buffer.alloc(0), "/etc/passwd"],
  ] as const)(
    "rejects %s without replacing the existing workspace",
    async (_name, path, type, data, target) => {
      // threat: T-17
      const paths = await createRoots();
      const runRoot = join(paths.workspaceRoot, runId);
      await mkdir(runRoot, { recursive: true });
      await writeFile(join(runRoot, "keep"), "original");
      const ref = await writeArchive(paths, maliciousArchive(path, type, data, target));

      await expect(snapshotter(paths).restore(runId, ref)).rejects.toMatchObject({
        code: "workspace_snapshot_unsafe",
      });
      await expect(readFile(join(runRoot, "keep"), "utf8")).resolves.toBe("original");
    },
  );

  it("rejects writing through a previously accepted symbolic link", async () => {
    // threat: T-17
    const paths = await createRoots();
    const runRoot = join(paths.workspaceRoot, runId);
    await mkdir(runRoot, { recursive: true });
    await writeFile(join(runRoot, "keep"), "original");
    const ref = await writeArchive(
      paths,
      archiveOf(
        tarEntry("link", "2", Buffer.alloc(0), "sub"),
        tarEntry("link/created", "0", Buffer.from("unsafe")),
      ),
    );

    await expect(snapshotter(paths).restore(runId, ref)).rejects.toMatchObject({
      code: "workspace_snapshot_unsafe",
    });
    await expect(readFile(join(runRoot, "keep"), "utf8")).resolves.toBe("original");
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
    await expect(snapshotterInstance.hasWorkspace(runId)).resolves.toBe(false);
    await snapshotterInstance.restore(runId, ref);
    await expect(readFile(join(runRoot, "secret.txt"), "utf8")).resolves.toBe(
      "synthetic workspace content",
    );
    expect(key).toEqual(Buffer.alloc(32, 7));

    await rm(runRoot, { recursive: true });
    const encryptionDisabled = snapshotter(paths, {
      snapshotEncryption: false,
      keyProvider: provider,
    });
    await encryptionDisabled.restore(runId, ref);
    await expect(readFile(join(runRoot, "secret.txt"), "utf8")).resolves.toBe(
      "synthetic workspace content",
    );
  });

  it("counts encryption overhead against the stored snapshot limit", async () => {
    const paths = await createRoots();
    const runRoot = join(paths.workspaceRoot, runId);
    await mkdir(runRoot);
    await writeFile(join(runRoot, "file"), "synthetic workspace content");
    const plainRef = await snapshotter(paths).snapshot(runId);
    const plainId = snapshotIdFrom(plainRef);
    const plainSize = (await stat(join(paths.snapshotRoot, runId, `${plainId}.tar.gz`))).size;
    const keyProvider: KeyProvider = {
      currentKeyId: () => "test_key",
      getKey: () => Promise.resolve(Buffer.alloc(32, 7)),
    };
    const encrypted = snapshotter(paths, {
      ids: ids("00000000000000000000000004"),
      maxSnapshotBytes: plainSize + 10,
      snapshotEncryption: true,
      keyProvider,
    });

    await expect(encrypted.snapshot(runId)).rejects.toBeInstanceOf(SnapshotTooLargeError);
    await expect(readdir(join(paths.snapshotRoot, runId))).resolves.toEqual([`${plainId}.tar.gz`]);
  });

  it("prunes old archives and deletes all archives when a run is purged", async () => {
    const paths = await createRoots();
    const runRoot = join(paths.workspaceRoot, runId);
    await mkdir(runRoot, { recursive: true });
    await writeFile(join(runRoot, "file"), "value");
    const first = Id.parse("00000000000000000000000004");
    const second = Id.parse("00000000000000000000000003");
    const instance = snapshotter(paths, {
      ids: ids(first, second, snapshotId),
      snapshotKeep: 1,
    });
    const orphaned = await instance.snapshot(runId);
    await instance.snapshot(runId);
    await instance.deleteSnapshot(runId, orphaned);
    const retainedRef = await instance.snapshot(runId);
    await writeFile(join(paths.snapshotRoot, runId, "temporary.archive"), "ignore");
    await instance.prune(runId, [retainedRef]);

    const directory = join(paths.snapshotRoot, runId);
    const retainedId = snapshotIdFrom(retainedRef);
    await expect(readdir(directory)).resolves.toEqual(
      expect.arrayContaining([`${retainedId}.tar.gz`, "temporary.archive"]),
    );
    await instance.purgeRun(runId);
    await expect(readdir(directory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(instance.hasWorkspace(runId)).resolves.toBe(true);
    await expect(
      purgeWorkspaceSnapshots(join(paths.snapshotRoot, "missing"), runId),
    ).resolves.toBeUndefined();
  });

  it("prunes by retained checkpoint refs when snapshot IDs are out of order", async () => {
    const paths = await createRoots();
    const runRoot = join(paths.workspaceRoot, runId);
    await mkdir(runRoot, { recursive: true });
    const instance = snapshotter(paths, {
      snapshotKeep: 2,
      ids: ids(
        "00000000000000000000000008",
        "00000000000000000000000006",
        "00000000000000000000000007",
        "00000000000000000000000002",
      ),
    });
    const refs: WorkspaceRef[] = [];
    for (let index = 0; index < 4; index += 1) {
      await writeFile(join(runRoot, "file"), String(index));
      refs.push(await instance.snapshot(runId));
    }

    const retainedRefs = refs.slice(-2);
    await instance.prune(runId, retainedRefs);

    await expect(readdir(join(paths.snapshotRoot, runId))).resolves.toEqual(
      retainedRefs.map((ref) => `${snapshotIdFrom(ref)}.tar.gz`).sort(),
    );
  });

  it("rejects invalid configuration and missing encryption keys", async () => {
    const paths = await createRoots();
    expect(() => snapshotter(paths, { maxSnapshotBytes: 0 })).toThrow(RangeError);
    expect(() => snapshotter(paths, { snapshotEncryption: true })).toThrow(WorkspaceSnapshotError);
  });
});
