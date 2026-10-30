// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runReplayGolden } from "./replay-golden.js";

it("refuses CI golden updates before touching the destination", async () => {
  const directory = await mkdtemp(join(tmpdir(), "replay-golden-update-"));
  try {
    await expect(
      runReplayGolden({ command: "update", directory, inCi: true }),
    ).rejects.toMatchObject({ code: "baseline_update_refused" });
    await expect(readdir(directory)).resolves.toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
