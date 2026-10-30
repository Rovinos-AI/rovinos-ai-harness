// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GradeResultSchema } from "./types.js";
import type { GradeContext } from "./types.js";
import { createFileDiffGrader } from "./file-diff.js";

const directories: string[] = [];

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "eval-file-grader-"));
  directories.push(directory);
  return directory;
}

function context(workspaceDir: string): GradeContext {
  return {
    result: {
      status: "completed",
      dbPath: join(workspaceDir, "run.db"),
      workspaceDir,
      durationMs: 0,
      usage: { inputTokens: 0, outputTokens: 0, costMicros: 0 },
    },
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("createFileDiffGrader", () => {
  it("compares expected files and checks expected substrings", async () => {
    const root = await workspace();
    const expectedFile = join(root, "expected.txt");
    await writeFile(join(root, "answer.txt"), "Answer: 42\n", "utf8");
    await writeFile(expectedFile, "Answer: 42\n", "utf8");

    await expect(
      createFileDiffGrader({
        type: "file_diff",
        path: "answer.txt",
        expectedFile,
        expectedContains: "42",
      }).grade(context(root)),
    ).resolves.toEqual({
      graderId: "file_diff",
      pass: true,
      score: 1,
      codes: [],
    });
  });

  it("normalizes whitespace when configured and reports mismatches", async () => {
    const root = await workspace();
    const expectedFile = join(root, "expected.txt");
    await writeFile(join(root, "answer.txt"), "one \n  two", "utf8");
    await writeFile(expectedFile, "one two", "utf8");

    await expect(
      createFileDiffGrader({
        type: "file_diff",
        path: "answer.txt",
        expectedFile,
        normalize: "whitespace",
      }).grade(context(root)),
    ).resolves.toMatchObject({ pass: true, score: 1, codes: [] });
    await expect(
      createFileDiffGrader({
        type: "file_diff",
        path: "answer.txt",
        expectedContains: "missing",
      }).grade(context(root)),
    ).resolves.toMatchObject({ pass: false, score: 0, codes: ["content_mismatch"] });
  });

  it("reports missing files and rejects traversal paths", async () => {
    const root = await workspace();
    await expect(
      createFileDiffGrader({
        type: "file_diff",
        path: "missing.txt",
        expectedContains: "x",
      }).grade(context(root)),
    ).resolves.toMatchObject({ pass: false, codes: ["file_missing"] });
    await expect(
      createFileDiffGrader({
        type: "file_diff",
        path: "../outside.txt",
        expectedContains: "x",
      }).grade(context(root)),
    ).rejects.toMatchObject({ code: "sandbox_workspace_path_invalid" });
  });

  it("never includes file contents in metadata-only results", async () => {
    const root = await workspace();
    const canary = "synthetic-file-canary-17";
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "nested", "answer.txt"), canary, "utf8");
    const result = await createFileDiffGrader({
      type: "file_diff",
      path: "nested/answer.txt",
      expectedContains: "absent",
    }).grade(context(root));

    expect(GradeResultSchema.safeParse(result).success).toBe(true);
    expect(JSON.stringify(result)).not.toContain(canary);
  });
});
