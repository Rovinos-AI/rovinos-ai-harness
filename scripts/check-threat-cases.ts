// SPDX-License-Identifier: Apache-2.0
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJson } from "@harness/schemas";
import { z } from "zod";

const taskIdSchema = z.string().regex(/^\d+\.\d+(?:\.\d+)?$/);
const sandboxTaskIdSchema = z.string().regex(/^19\.\d+$/);
const testFileSchema = z
  .string()
  .regex(
    /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:(?:int|canary|replay)\.)?test\.(?:ts|tsx|js|jsx|mjs|cjs)$/,
  );

/** One sandbox threat and the test source expected to cover it. */
export const ThreatCaseSchema = z
  .object({
    id: z.string().regex(/^T-\d{2}$/),
    title: z.string().min(1),
    mitigationTask: sandboxTaskIdSchema,
    testFile: testFileSchema,
    activeFromTask: sandboxTaskIdSchema,
  })
  .strict()
  .superRefine((threatCase, context) => {
    if (threatCase.activeFromTask !== threatCase.mitigationTask) {
      context.addIssue({
        code: "custom",
        message: "Threat cases activate when their mitigation task is complete.",
        path: ["activeFromTask"],
      });
    }
  });

/** A threat catalog with unique stable identifiers in required order. */
export const ThreatCasesSchema = z.array(ThreatCaseSchema).superRefine((cases, context) => {
  const expectedIds = Array.from(
    { length: 19 },
    (_, index) => `T-${String(index + 1).padStart(2, "0")}`,
  );
  const ids = new Set<string>();
  for (const [index, threatCase] of cases.entries()) {
    if (ids.has(threatCase.id)) {
      context.addIssue({
        code: "custom",
        message: "Threat case identifiers must be unique.",
        path: [index, "id"],
      });
    }
    ids.add(threatCase.id);

    if (threatCase.id !== expectedIds[index]) {
      context.addIssue({
        code: "custom",
        message: "Threat cases must contain T-01 through T-19 in order.",
        path: [index, "id"],
      });
    }
  }

  if (cases.length !== expectedIds.length) {
    context.addIssue({
      code: "custom",
      message: "Threat cases must contain exactly T-01 through T-19 in order.",
    });
  }
});

/** The completed task ids used to activate threat coverage checks. */
export const ProgressSchema = z
  .object({
    completed: z.array(taskIdSchema),
  })
  .strict();

/** Validated sandbox threat case. */
export type ThreatCase = z.infer<typeof ThreatCaseSchema>;

/** Validated repository task progress. */
export type Progress = z.infer<typeof ProgressSchema>;

const threatComment = /^\s*\/\/\s*threat:\s*(T-\d{2})\b/gm;

/**
 * Finds active threat coverage problems in their declared test files.
 *
 * @param cases - Validated threat catalog.
 * @param completedTasks - Tasks recorded as complete.
 * @param testFileContents - Contents for each active case's declared test file, or undefined if missing.
 * @returns Diagnostics for active cases with missing test files or references.
 */
export function findThreatCoverageIssues(
  cases: readonly ThreatCase[],
  completedTasks: ReadonlySet<string>,
  testFileContents: ReadonlyMap<string, string | undefined>,
): string[] {
  const issues: string[] = [];

  for (const threatCase of cases) {
    if (!completedTasks.has(threatCase.activeFromTask)) {
      continue;
    }

    const contents = testFileContents.get(threatCase.testFile);
    if (contents === undefined) {
      issues.push(`Missing active threat test file '${threatCase.testFile}' for ${threatCase.id}.`);
      continue;
    }

    const referencesThreat = Array.from(contents.matchAll(threatComment)).some(
      ([, id]) => id === threatCase.id,
    );
    if (!referencesThreat) {
      issues.push(
        `Missing active threat test reference '${threatCase.id}' in '${threatCase.testFile}'.`,
      );
    }
  }

  return issues;
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function readTestFile(root: string, path: string): Promise<string | undefined> {
  try {
    return await readFile(join(root, path), "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw error;
  }
}

/** Runs the threat coverage check against a repository root. */
export async function checkThreatCases(root: string): Promise<string[]> {
  const [catalogText, progressText] = await Promise.all([
    readFile(join(root, "test/sandbox/cases.json"), "utf8"),
    readFile(join(root, "docs/progress.json"), "utf8"),
  ]);
  const cases = parseJson(ThreatCasesSchema, catalogText);
  const progress = parseJson(ProgressSchema, progressText);
  const completedTasks = new Set(progress.completed);
  const activeTestFiles = new Set(
    cases
      .filter((threatCase) => completedTasks.has(threatCase.activeFromTask))
      .map((threatCase) => threatCase.testFile),
  );
  const testFileEntries = await Promise.all(
    [...activeTestFiles].map(async (path) => [path, await readTestFile(root, path)] as const),
  );

  return findThreatCoverageIssues(cases, completedTasks, new Map(testFileEntries));
}

async function runCheck(): Promise<void> {
  const root = process.argv[2] ?? fileURLToPath(new URL("../", import.meta.url));
  const issues = await checkThreatCases(root);

  if (issues.length > 0) {
    process.stderr.write(`${issues.join("\n")}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runCheck();
}
