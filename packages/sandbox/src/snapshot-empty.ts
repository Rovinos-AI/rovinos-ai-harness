// SPDX-License-Identifier: Apache-2.0
// Empty workspace archive for remote runners whose run workspace does not exist yet (#534). The
// runner creates a run's workspace only when it activates a lease for a command, so a run that
// checkpoints before its first command has nothing to archive remotely. The local path archives a
// freshly laid-out workspace in that case; this produces the same layout.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import type { Id } from "@rovinos/schemas";
import { createWorkspaceArchive } from "./snapshot-archive.js";
import { ensureRunWorkspace } from "./workspace.js";

/** Archives an empty run workspace with the standard layout, removing the scratch copy afterwards. */
export async function createEmptyWorkspaceArchive(
  runId: Id,
  scratchRoot: string = tmpdir(),
): Promise<Readable> {
  const root = await mkdtemp(join(scratchRoot, "harness-empty-workspace-"));
  try {
    await ensureRunWorkspace(root, runId);
    const archive = createWorkspaceArchive(join(root, runId));
    archive.once("close", () => {
      void rm(root, { recursive: true, force: true });
    });
    return archive;
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
