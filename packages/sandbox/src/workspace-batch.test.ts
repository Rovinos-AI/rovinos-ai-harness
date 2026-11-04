// SPDX-License-Identifier: Apache-2.0
import { constants } from "node:fs";
import type * as fsPromises from "node:fs/promises";
import { WorkspacePathError } from "@rovinos/context";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { publishWorkspaceBatch } from "./workspace-batch.js";

const filesystem = vi.hoisted(() => ({
  lstat: vi.fn<() => Promise<void>>(),
  open: vi.fn(),
  writeFile: vi.fn<() => Promise<void>>(),
  close: vi.fn<() => Promise<void>>(),
  rename: vi.fn<() => Promise<void>>(),
  unlink: vi.fn<() => Promise<void>>(),
}));

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof fsPromises>()),
  lstat: filesystem.lstat,
  open: filesystem.open,
  rename: filesystem.rename,
  unlink: filesystem.unlink,
}));

const entries = [
  { path: ".harness/offload/first.bin", data: Buffer.from("first") },
  { path: ".harness/offload/second.bin", data: Buffer.from("second") },
];
const resolvePath = (path: string): Promise<string> => Promise.resolve(path);

beforeEach(() => {
  vi.resetAllMocks();
  filesystem.lstat.mockRejectedValue(Object.assign(new Error("synthetic"), { code: "ENOENT" }));
  filesystem.open.mockResolvedValue({
    writeFile: filesystem.writeFile,
    close: filesystem.close,
  });
  filesystem.writeFile.mockResolvedValue(undefined);
  filesystem.close.mockResolvedValue(undefined);
  filesystem.rename.mockResolvedValue(undefined);
  filesystem.unlink.mockResolvedValue(undefined);
});

describe("workspace batch publication", () => {
  it("stages private exclusive files before publishing the ordered batch", async () => {
    await expect(publishWorkspaceBatch(entries, resolvePath)).resolves.toEqual(
      entries.map(({ path }) => path),
    );
    expect(filesystem.open).toHaveBeenNthCalledWith(
      1,
      expect.stringMatching(/^\.harness\/offload\/\.batch-[a-f0-9-]+-0$/u),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    expect(filesystem.writeFile).toHaveBeenNthCalledWith(1, entries[0]?.data);
    expect(filesystem.writeFile).toHaveBeenNthCalledWith(2, entries[1]?.data);
    expect(filesystem.close).toHaveBeenCalledTimes(2);
    expect(filesystem.writeFile.mock.invocationCallOrder[1]).toBeLessThan(
      filesystem.rename.mock.invocationCallOrder[0] ?? 0,
    );
    expect(filesystem.unlink).not.toHaveBeenCalled();
  });

  // threat: T-12
  it("refuses an existing target without opening or removing it", async () => {
    filesystem.lstat.mockResolvedValueOnce(undefined);
    await expect(publishWorkspaceBatch(entries, resolvePath)).rejects.toBeInstanceOf(
      WorkspacePathError,
    );
    expect(filesystem.open).not.toHaveBeenCalled();
    expect(filesystem.unlink).not.toHaveBeenCalled();
  });

  it.each([
    Object.assign(new Error("synthetic"), { code: "EACCES" }),
    new Error("synthetic"),
    { code: "ENOENT" },
  ])("fails closed for unexpected target inspection failures: %j", async (error) => {
    filesystem.lstat.mockRejectedValueOnce(error);
    await expect(publishWorkspaceBatch(entries, resolvePath)).rejects.toBeInstanceOf(
      WorkspacePathError,
    );
    expect(filesystem.open).not.toHaveBeenCalled();
    expect(filesystem.rename).not.toHaveBeenCalled();
  });

  it("cleans staged files when a later exclusive open fails", async () => {
    filesystem.open
      .mockResolvedValueOnce({
        writeFile: filesystem.writeFile,
        close: filesystem.close,
      })
      .mockRejectedValueOnce(new Error("synthetic"));
    await expect(publishWorkspaceBatch(entries, resolvePath)).rejects.toBeInstanceOf(
      WorkspacePathError,
    );
    expect(filesystem.rename).not.toHaveBeenCalled();
    expect(filesystem.unlink).toHaveBeenCalledExactlyOnceWith(
      expect.stringMatching(/^\.harness\/offload\/\.batch-[a-f0-9-]+-0$/u),
    );
  });

  it("closes and removes a staged file after its write fails", async () => {
    filesystem.writeFile.mockRejectedValueOnce(new Error("synthetic"));
    await expect(publishWorkspaceBatch(entries, resolvePath)).rejects.toBeInstanceOf(
      WorkspacePathError,
    );
    expect(filesystem.close).toHaveBeenCalledOnce();
    expect(filesystem.rename).not.toHaveBeenCalled();
    expect(filesystem.unlink).toHaveBeenCalledWith(
      expect.stringMatching(/^\.harness\/offload\/\.batch-/u),
    );
  });

  it("rolls back published and staged files even when one cleanup fails", async () => {
    filesystem.rename
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("synthetic"));
    filesystem.unlink.mockRejectedValueOnce(new Error("synthetic cleanup"));
    await expect(publishWorkspaceBatch(entries, resolvePath)).rejects.toBeInstanceOf(
      WorkspacePathError,
    );
    expect(filesystem.unlink).toHaveBeenCalledTimes(3);
    expect(filesystem.unlink).toHaveBeenNthCalledWith(3, entries[0]?.path);
    expect(filesystem.unlink).not.toHaveBeenCalledWith(entries[1]?.path);
  });
});
