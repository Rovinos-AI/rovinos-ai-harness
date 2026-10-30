// SPDX-License-Identifier: Apache-2.0
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolveWorkspacePath } from "@rovinos/sandbox";
import type { GraderSpec } from "../schema.js";
import type { Grader, GradeContext } from "./types.js";
import { makeGradeResult } from "./types.js";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
type FileDiffSpec = Extract<GraderSpec, { type: "file_diff" }>;

async function readBoundedText(path: string): Promise<string | undefined> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_FILE_BYTES) {
      return undefined;
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (totalBytes <= MAX_FILE_BYTES) {
      const chunk = Buffer.alloc(Math.min(READ_CHUNK_BYTES, MAX_FILE_BYTES + 1 - totalBytes));
      const { bytesRead } = await file.read(chunk, 0, chunk.byteLength, totalBytes);
      if (bytesRead === 0) {
        break;
      }
      totalBytes += bytesRead;
      if (totalBytes > MAX_FILE_BYTES) {
        return undefined;
      }
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, totalBytes).toString("utf8");
  } finally {
    await file.close();
  }
}

function normalized(value: string): string {
  return value.replaceAll(/\s+/gu, " ").trim();
}

/**
 * Creates a grader comparing a trial workspace file with an expected file or substring.
 *
 * @param spec - Validated file-diff grader specification.
 */
export function createFileDiffGrader(spec: FileDiffSpec): Grader {
  return {
    id: "file_diff",
    async grade(ctx: GradeContext) {
      const path = await resolveWorkspacePath(ctx.result.workspaceDir, spec.path, {
        allowMissing: true,
      });
      let actual: string | undefined;
      try {
        actual = await readBoundedText(path);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          return makeGradeResult("file_diff", false, "file_missing");
        }
        throw error;
      }
      if (actual === undefined) {
        return makeGradeResult("file_diff", false, "file_missing");
      }

      const containsExpected =
        spec.expectedContains === undefined || actual.includes(spec.expectedContains);
      let fileMatches = true;
      if (spec.expectedFile !== undefined) {
        const expected = await readBoundedText(spec.expectedFile);
        fileMatches =
          expected !== undefined &&
          (spec.normalize === "whitespace"
            ? normalized(actual) === normalized(expected)
            : actual === expected);
      }
      const pass = containsExpected && fileMatches;
      return makeGradeResult("file_diff", pass, pass ? undefined : "content_mismatch");
    },
  };
}
