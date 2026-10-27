// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Id } from "@rovinos/schemas";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as WorkspaceModule from "./workspace.js";

const workspaceMocks = vi.hoisted(() => ({
  ensureRunWorkspace: vi.fn(),
}));

vi.mock("./workspace.js", async (importOriginal) => {
  const actual = await importOriginal<typeof WorkspaceModule>();
  return { ...actual, ensureRunWorkspace: workspaceMocks.ensureRunWorkspace };
});

import { createEmptyWorkspaceArchive } from "./snapshot-empty.js";

const scratchRoots: string[] = [];

afterEach(async () => {
  workspaceMocks.ensureRunWorkspace.mockReset();
  await Promise.all(
    scratchRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("empty workspace archive cleanup", () => {
  it("removes its scratch workspace when the standard layout cannot be created", async () => {
    const root = await mkdtemp(join(process.cwd(), ".tmp", "snapshot-empty-error-"));
    scratchRoots.push(root);
    workspaceMocks.ensureRunWorkspace.mockRejectedValue(new Error("synthetic layout failure"));

    await expect(
      createEmptyWorkspaceArchive(Id.parse("00000000000000000000000001"), root),
    ).rejects.toThrow("synthetic layout failure");
    expect(await readdir(root)).toEqual([]);
  });
});
