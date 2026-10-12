// SPDX-License-Identifier: Apache-2.0
import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJson } from "@harness/schemas";
import { z } from "zod";

const taskIdSchema = z.string().regex(/^\d+\.\d+(?:\.\d+)?$/);

/** One sandbox threat and the test source expected to cover it. */
export const ThreatCaseSchema = z
  .object({
    id: z.string().regex(/^T-\d{2}$/),
    title: z.string().min(1),
    mitigationTask: taskIdSchema,
    testFile: z.string().min(1),
    activeFromTask: taskIdSchema,
  })
  .strict();

/** A threat catalog with unique stable identifiers. */
export const ThreatCasesSchema = z.array(ThreatCaseSchema).superRefine((cases, context) => {
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

const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const excludedDirectories = new Set(["node_modules", "dist", "coverage", "__golden__"]);
const threatComment = /^\s*\/\/\s*threat:\s*(T-\d{2})\b/gm;

/**
 * Finds active threat ids with no test-source comment reference.
 *
 * @param cases - Validated threat catalog.
 * @param completedTasks - Tasks recorded as complete.
 * @param referencedIds - Threat ids found in test and package source comments.
 * @returns Active threat ids missing a test reference.
 */
export function findMissingThreatIds(
  cases: readonly ThreatCase[],
  completedTasks: ReadonlySet<string>,
  referencedIds: ReadonlySet<string>,
): string[] {
  return cases
    .filter(
      (threatCase) =>
        completedTasks.has(threatCase.activeFromTask) && !referencedIds.has(threatCase.id),
    )
    .map(({ id }) => id);
}

async function collectSourceFiles(directory: string, root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!excludedDirectories.has(entry.name)) {
        files.push(...(await collectSourceFiles(join(directory, entry.name), root)));
      }
      continue;
    }

    if (entry.isFile() && sourceExtensions.has(extname(entry.name))) {
      files.push(relative(root, join(directory, entry.name)).split(sep).join("/"));
    }
  }
  return files;
}

function referencedThreatIds(contents: readonly string[]): Set<string> {
  const ids = new Set<string>();
  for (const content of contents) {
    for (const match of content.matchAll(threatComment)) {
      const id = match[1];
      if (id !== undefined) {
        ids.add(id);
      }
    }
  }
  return ids;
}

async function runCheck(): Promise<void> {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const [catalogText, progressText] = await Promise.all([
    readFile(join(root, "test/sandbox/cases.json"), "utf8"),
    readFile(join(root, "docs/progress.json"), "utf8"),
  ]);
  const cases = parseJson(ThreatCasesSchema, catalogText);
  const progress = parseJson(ProgressSchema, progressText);
  const sourcePaths = (
    await Promise.all(["test", "packages"].map((directory) => collectSourceFiles(join(root, directory), root)))
  ).flat();
  const sourceContents = await Promise.all(
    sourcePaths.map((path) => readFile(join(root, path), "utf8")),
  );
  const missingIds = findMissingThreatIds(
    cases,
    new Set(progress.completed),
    referencedThreatIds(sourceContents),
  );

  if (missingIds.length > 0) {
    process.stderr.write(`Missing active threat test references: ${missingIds.join(", ")}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runCheck();
}
