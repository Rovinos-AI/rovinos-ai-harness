// SPDX-License-Identifier: Apache-2.0
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJson } from "@rovinos/schemas";
import ts from "typescript";
import { z } from "zod";

const testFileSchema = z
  .string()
  .regex(
    /^(?!.*(?:^|\/)\.\.(?:\/|$))[\w.-]+(?:\/[\w.-]+)*\.(?:(?:int|canary|replay)\.)?test\.(?:ts|tsx|js|jsx|mjs|cjs)$/,
  );

/** One sandbox threat and the test source expected to cover it. */
export const ThreatCaseSchema = z
  .object({
    id: z.string().regex(/^T-\d{2}$/),
    title: z.string().min(1),
    testFile: testFileSchema,
    testName: z.string().min(1),
  })
  .strict();

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

/** Validated sandbox threat case. */
export type ThreatCase = z.infer<typeof ThreatCaseSchema>;

const threatComment = /^\s*\/\/\s*threat:\s*(T-\d{2})\b/gm;

function isTestCallExpression(expression: ts.Expression): boolean {
  if (ts.isIdentifier(expression)) {
    return expression.text === "it" || expression.text === "test";
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return isTestCallExpression(expression.expression);
  }
  if (ts.isCallExpression(expression)) {
    return isTestCallExpression(expression.expression);
  }
  return false;
}

function findTestDeclaration(
  contents: string,
  testFile: string,
  testName: string,
): string | undefined {
  const sourceFile = ts.createSourceFile(testFile, contents, ts.ScriptTarget.Latest, true);
  let declaration: string | undefined;

  const visit = (node: ts.Node): void => {
    if (
      declaration === undefined &&
      ts.isCallExpression(node) &&
      isTestCallExpression(node.expression)
    ) {
      const name = node.arguments[0];
      if (name !== undefined && ts.isStringLiteralLike(name) && name.text === testName) {
        declaration = contents.slice(node.getFullStart(), node.end);
      }
    }

    if (declaration === undefined) {
      ts.forEachChild(node, visit);
    }
  };
  visit(sourceFile);
  return declaration;
}

/**
 * Finds threat coverage problems in their declared tests.
 *
 * @param cases - Validated threat catalog.
 * @param testFileContents - Contents for each declared test file, or undefined if missing.
 * @returns Diagnostics for cases with missing tests or threat markers.
 */
export function findThreatCoverageIssues(
  cases: readonly ThreatCase[],
  testFileContents: ReadonlyMap<string, string | undefined>,
): string[] {
  const issues: string[] = [];

  for (const threatCase of cases) {
    const contents = testFileContents.get(threatCase.testFile);
    if (contents === undefined) {
      issues.push(`Missing threat test file '${threatCase.testFile}' for ${threatCase.id}.`);
      continue;
    }

    const declaration = findTestDeclaration(contents, threatCase.testFile, threatCase.testName);
    if (declaration === undefined) {
      issues.push(
        `Missing threat test '${threatCase.testName}' in '${threatCase.testFile}' for ${threatCase.id}.`,
      );
      continue;
    }

    const referencesThreat = Array.from(declaration.matchAll(threatComment)).some(
      ([, id]) => id === threatCase.id,
    );
    if (!referencesThreat) {
      issues.push(
        `Missing threat test reference '${threatCase.id}' in '${threatCase.testFile}' for '${threatCase.testName}'.`,
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
  const catalogText = await readFile(join(root, "test/sandbox/cases.json"), "utf8");
  const cases = parseJson(ThreatCasesSchema, catalogText);
  const testFileEntries = await Promise.all(
    [...new Set(cases.map((threatCase) => threatCase.testFile))].map(
      async (path) => [path, await readTestFile(root, path)] as const,
    ),
  );

  return findThreatCoverageIssues(cases, new Map(testFileEntries));
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
