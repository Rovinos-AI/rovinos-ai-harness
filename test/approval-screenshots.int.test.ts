// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, describe, expect, it } from "vitest";
import { generateApprovalScreenshots } from "../scripts/docs/screenshots.ts";

const outputNames = [
  "approval-pending.png",
  "approval-edit.png",
  "approval-reveal-confirmation.png",
  "approval-expired.png",
  "approval-fallback.png",
] as const;

const temporaryDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("approval screenshot generation", () => {
  it("writes non-empty PNGs at the expected dimensions", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "approval-screenshots-"));
    temporaryDirectories.push(outputDirectory);

    await generateApprovalScreenshots(outputDirectory);

    for (const filename of outputNames) {
      const image = await readFile(join(outputDirectory, filename));
      expect(image.length).toBeGreaterThan(24);
      expect(image.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect(image.readUInt32BE(16)).toBe(1280);
      expect(image.readUInt32BE(20)).toBe(900);
    }
  }, 60_000);
});
