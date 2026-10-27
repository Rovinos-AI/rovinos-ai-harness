// SPDX-License-Identifier: Apache-2.0
import { link, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertActive,
  decodeText,
  decodeUtf8Prefix,
  fileAt,
  fileIdentity,
  projectPath,
  readFileAt,
  readFileSnapshotAt,
  readTextRangeAt,
  sha256,
  WorkspaceFileError,
  writeFileAt,
} from "./workspace-file-helpers.js";

const roots: string[] = [];

async function createRoot(): Promise<string> {
  const temporaryDirectory = join(process.cwd(), ".tmp");
  await mkdir(temporaryDirectory, { recursive: true });
  const root = await mkdtemp(join(temporaryDirectory, "workspace-file-helpers-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("workspace file helpers", () => {
  it("validates project paths and captures regular file identities", async () => {
    const root = await createRoot();
    const file = join(root, "file.txt");
    const alias = join(root, "alias.txt");
    await writeFile(file, "synthetic");

    await expect(projectPath(root, "file.txt")).resolves.toBe(file);
    await expect(projectPath(root, ".harness/secret")).rejects.toMatchObject({
      code: "fs_path_invalid",
    });
    await expect(projectPath(root, "../escape")).rejects.toMatchObject({
      code: "fs_path_invalid",
    });
    const identity = fileIdentity(await lstat(file));
    expect(identity.size).toBe(Buffer.byteLength("synthetic"));
    await link(file, alias);
    await expect(lstat(alias).then((info) => fileIdentity(info))).rejects.toMatchObject({
      code: "fs_path_invalid",
    });
  });

  it("reads files and ranges without following invalid or binary paths", async () => {
    const root = await createRoot();
    const textPath = join(root, "text.txt");
    const binaryPath = join(root, "binary.bin");
    await writeFile(textPath, "éx");
    await writeFile(binaryPath, Buffer.from([0, 1, 2]));

    await expect(readFileAt(textPath)).resolves.toEqual(Buffer.from("éx"));
    await expect(readFileSnapshotAt(join(root, "missing"))).rejects.toMatchObject({
      code: "fs_file_not_found",
    });
    await expect(readFileSnapshotAt(root)).rejects.toMatchObject({ code: "fs_not_file" });
    await expect(readTextRangeAt(textPath, 0, 0)).resolves.toMatchObject({
      binary: false,
      bytes: 0,
      content: "",
      offset: 0,
    });
    await expect(readTextRangeAt(textPath, 0, 1)).resolves.toMatchObject({
      binary: false,
      bytes: 0,
      content: "",
    });
    await expect(readTextRangeAt(textPath, 1, 1)).resolves.toMatchObject({
      binary: false,
      content: "x",
      offset: 2,
    });
    await expect(readTextRangeAt(binaryPath, 0, 10)).resolves.toMatchObject({
      binary: true,
      fileBytes: 3,
    });
    await expect(fileAt(join(root, "missing"))).resolves.toEqual({ exists: false });
    await expect(fileAt(textPath)).resolves.toMatchObject({
      exists: true,
      bytes: Buffer.from("éx"),
    });
  });

  it("decodes bounded UTF-8 prefixes and rejects invalid text", () => {
    expect(decodeUtf8Prefix(Buffer.from([0x61, 0xe2, 0x82]), true)).toBe("a");
    expect(decodeUtf8Prefix(Buffer.from([0xe2, 0x82]), false)).toBeUndefined();
    expect(decodeText(Buffer.from([0]))).toBeUndefined();
    expect(decodeText(Buffer.from([0xff]))).toBeUndefined();
    expect(sha256(Buffer.from("synthetic"))).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("publishes create and overwrite writes only when their preconditions hold", async () => {
    const root = await createRoot();
    const file = join(root, "file.txt");
    const active = new AbortController().signal;
    await writeFileAt(file, Buffer.from("created"), { mode: "create", signal: active });
    await expect(readFileAt(file)).resolves.toEqual(Buffer.from("created"));
    await expect(
      writeFileAt(file, Buffer.from("duplicate"), { mode: "create", signal: active }),
    ).rejects.toMatchObject({ code: "fs_file_exists" });

    const snapshot = await readFileSnapshotAt(file);
    await writeFileAt(file, Buffer.from("updated"), {
      mode: "overwrite",
      signal: active,
      expectedIdentity: snapshot.identity,
    });
    await expect(readFileAt(file)).resolves.toEqual(Buffer.from("updated"));
    await expect(
      writeFileAt(join(root, "missing"), Buffer.from("missing"), {
        mode: "overwrite",
        signal: active,
        expectedIdentity: snapshot.identity,
      }),
    ).rejects.toMatchObject({ code: "fs_file_not_found" });
    await expect(
      writeFileAt(file, Buffer.from("stale"), {
        mode: "overwrite",
        signal: active,
        expectedIdentity: snapshot.identity,
      }),
    ).rejects.toMatchObject({ code: "precondition_failed" });
  });

  it("aborts before publishing and removes the private temporary file", async () => {
    const root = await createRoot();
    const file = join(root, "cancelled.txt");
    const controller = new AbortController();
    await expect(
      writeFileAt(file, Buffer.from("not published"), {
        mode: "create",
        signal: controller.signal,
        onTemporaryFileCreated: () => {
          controller.abort();
        },
      }),
    ).rejects.toBeInstanceOf(WorkspaceFileError);
    expect(await readdir(root)).toEqual([]);
    expect(() => {
      assertActive(controller.signal);
    }).toThrow(WorkspaceFileError);
  });
});
