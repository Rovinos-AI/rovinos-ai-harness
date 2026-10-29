// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJson } from "@rovinos/schemas";
import { z } from "zod";

/** Schema for the TypeDoc JSON reflection fields used by the coverage check. */
export const TypeDocReflectionSchema = z
  .object({
    kind: z.number().int().optional(),
    name: z.string().optional(),
    children: z.array(z.unknown()).optional(),
    comment: z
      .object({
        summary: z.array(z.object({ text: z.string() }).loose()).optional(),
        blockTags: z.array(z.object({ tag: z.string() }).loose()).optional(),
      })
      .loose()
      .optional(),
  })
  .loose();

/** TypeDoc reflection fields consumed by the coverage calculator. */
export type TypeDocReflection = z.infer<typeof TypeDocReflectionSchema>;

/** Counts documented public declarations and returns the names that lack descriptions. */
export interface ApiCoverage {
  readonly documented: number;
  readonly total: number;
  readonly percent: number;
  readonly undocumented: readonly string[];
}

const documentedKinds = new Set([64, 128, 256, 2_097_152]);
const maxJsonBytes = 32 * 1024 * 1024;

/**
 * Calculates documentation coverage for the requested package modules.
 *
 * @param project - Parsed TypeDoc project model.
 * @param packageNames - Public package modules included in the coverage calculation.
 * @returns Counts and names for declarations with missing descriptions.
 */
export function calculateApiCoverage(
  project: TypeDocReflection,
  packageNames: readonly string[],
): ApiCoverage {
  let documented = 0;
  let total = 0;
  const undocumented: string[] = [];

  function visit(reflection: TypeDocReflection, ancestors: readonly string[]): void {
    const name = reflection.name ?? "unknown";
    const path = [...ancestors, name];
    const isInternal = reflection.comment?.blockTags?.some(
      ({ tag }) => tag.replace(/^@/u, "").toLowerCase() === "internal",
    );

    if (
      isInternal !== true &&
      reflection.kind !== undefined &&
      documentedKinds.has(reflection.kind)
    ) {
      total += 1;
      const description = reflection.comment?.summary
        ?.map(({ text }) => text)
        .join("")
        .trim();
      if (description !== undefined && description.length > 0) {
        documented += 1;
      } else {
        undocumented.push(path.join("."));
      }
    }

    if (isInternal !== true) {
      for (const child of reflection.children ?? []) {
        visit(TypeDocReflectionSchema.parse(child), path);
      }
    }
  }

  const packageNameSet = new Set(packageNames);
  for (const rawChild of project.children ?? []) {
    const child = TypeDocReflectionSchema.parse(rawChild);
    if (child.name !== undefined && packageNameSet.has(child.name)) {
      visit(child, project.name === undefined ? [] : [project.name]);
    }
  }
  undocumented.sort();
  return {
    documented,
    total,
    percent: total === 0 ? 0 : (documented / total) * 100,
    undocumented,
  };
}

/**
 * Reads the TypeDoc JSON model and fails when documentation coverage is below 90 percent.
 *
 * @param jsonPath - Path to the generated TypeDoc JSON project model.
 * @returns The calculated coverage report.
 */
export function checkApiCoverage(jsonPath: string): ApiCoverage {
  const project = parseJson(TypeDocReflectionSchema, readFileSync(jsonPath, "utf8"), {
    maxBytes: maxJsonBytes,
  });
  const coverage = calculateApiCoverage(project, [
    "@rovinos/cli",
    "@rovinos/sdk",
    "@rovinos/store-postgres",
    "@rovinos/store-sqlite",
  ]);
  process.stdout.write(
    `API documentation coverage: ${String(coverage.documented)}/${String(coverage.total)} (${coverage.percent.toFixed(2)}%)\n`,
  );
  if (coverage.undocumented.length > 0) {
    process.stderr.write(`Undocumented exports:\n${coverage.undocumented.join("\n")}\n`);
  }
  if (coverage.percent < 90) {
    process.stderr.write("API documentation coverage must be at least 90%.\n");
    process.exitCode = 1;
  }
  return coverage;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rootDirectory = fileURLToPath(new URL("../../", import.meta.url));
  const jsonPath = resolve(rootDirectory, process.argv[2] ?? "docs/api/typedoc.json");
  checkApiCoverage(jsonPath);
}
