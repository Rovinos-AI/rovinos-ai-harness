// SPDX-License-Identifier: Apache-2.0
import { createReadStream } from "node:fs";
import { dirname, extname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ContractError, parseJson, parseYaml } from "@harness/schemas";
import type { ContractIssue } from "@harness/schemas";
import { z } from "zod";
import { EvalSuiteSchema } from "./schema.js";
import type { EvalSuite, GraderSpec } from "./schema.js";

const LoadSuiteOptionsSchema = z.object({ cwd: z.string().optional() }).strict();
const MAX_SUITE_BYTES = 1_048_576;

/** Options for resolving a suite path. */
export type LoadSuiteOptions = z.infer<typeof LoadSuiteOptionsSchema>;

function issuesFromZod(error: z.ZodError): ContractIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map((segment) => (typeof segment === "symbol" ? String(segment) : segment)),
    code:
      issue.code === "custom" && typeof issue.params?.errorCode === "string"
        ? issue.params.errorCode
        : issue.code,
  }));
}

function parseSuite(input: unknown): EvalSuite {
  const result = EvalSuiteSchema.safeParse(input);
  if (!result.success) {
    throw new ContractError(issuesFromZod(result.error));
  }
  return result.data;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function moduleSuite(moduleValue: unknown): unknown {
  if (!isRecord(moduleValue)) {
    return undefined;
  }
  if (Object.hasOwn(moduleValue, "default")) {
    return moduleValue.default;
  }
  return moduleValue.suite;
}

function resolvePath(path: string, suiteDirectory: string): string {
  return isAbsolute(path) ? path : resolve(suiteDirectory, path);
}

function resolveSchemaRef(schemaRef: string, suiteDirectory: string): string {
  const separator = schemaRef.lastIndexOf("#");
  const modulePath = schemaRef.slice(0, separator);
  const exportName = schemaRef.slice(separator + 1);
  return `${resolvePath(modulePath, suiteDirectory)}#${exportName}`;
}

function resolveGraderPaths(grader: GraderSpec, suiteDirectory: string): GraderSpec {
  if (grader.type === "file_diff") {
    return {
      ...grader,
      ...(grader.expectedFile === undefined
        ? {}
        : { expectedFile: resolvePath(grader.expectedFile, suiteDirectory) }),
    };
  }
  if (grader.type === "schema_valid") {
    return { ...grader, schemaRef: resolveSchemaRef(grader.schemaRef, suiteDirectory) };
  }
  return grader;
}

function resolveSuitePaths(suite: EvalSuite, suiteDirectory: string): EvalSuite {
  return {
    ...suite,
    tasks: suite.tasks.map((task) => ({
      ...task,
      ...(task.workspace === undefined
        ? {}
        : {
            workspace: {
              ...task.workspace,
              fixtureDir: resolvePath(task.workspace.fixtureDir, suiteDirectory),
            },
          }),
      ...(task.policyFile === undefined
        ? {}
        : { policyFile: resolvePath(task.policyFile, suiteDirectory) }),
      graders: task.graders.map((grader) => resolveGraderPaths(grader, suiteDirectory)),
    })),
  };
}

async function readSuiteFile(path: string): Promise<string> {
  const chunks: Buffer[] = [];
  let bytesRead = 0;
  try {
    for await (const rawChunk of createReadStream(path)) {
      const chunk: unknown = rawChunk;
      if (!Buffer.isBuffer(chunk)) {
        throw new ContractError([{ path: [], code: "suite_file_invalid" }]);
      }
      bytesRead += chunk.byteLength;
      if (bytesRead > MAX_SUITE_BYTES) {
        throw new ContractError([{ path: [], code: "size_limit_exceeded" }]);
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof ContractError) {
      throw error;
    }
    throw new ContractError([{ path: [], code: "suite_file_unavailable" }]);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Validates an in-memory eval suite.
 *
 * @param suite - Untrusted suite data to validate.
 * @returns The schema-inferred suite, including schema defaults.
 * @throws ContractError with path and code issues when the suite is invalid.
 */
export function defineSuite(suite: unknown): EvalSuite {
  return parseSuite(suite);
}

/**
 * Loads and validates a TypeScript, YAML, or JSON eval suite.
 *
 * Relative fixture, policy, expected-file, and schema-module paths resolve
 * against the suite file's directory. TypeScript suites use Node's built-in
 * type stripping supported by the pinned Node runtime.
 *
 * @param path - Suite file path.
 * @param options - Optional working directory for a relative suite path.
 * @returns The validated suite with file references resolved.
 * @throws ContractError with path and code issues when loading or validation fails.
 */
export async function loadSuite(path: string, options: LoadSuiteOptions = {}): Promise<EvalSuite> {
  const parsedOptions = LoadSuiteOptionsSchema.safeParse(options);
  if (!parsedOptions.success) {
    throw new ContractError(issuesFromZod(parsedOptions.error));
  }
  const pathResult = z.string().min(1).safeParse(path);
  if (!pathResult.success) {
    throw new ContractError(issuesFromZod(pathResult.error));
  }

  const absolutePath = resolve(parsedOptions.data.cwd ?? process.cwd(), pathResult.data);
  const suiteDirectory = dirname(absolutePath);
  const extension = extname(absolutePath).toLowerCase();
  let suite: EvalSuite;

  if (extension === ".ts") {
    let imported: unknown;
    try {
      imported = await import(pathToFileURL(absolutePath).href);
    } catch (error) {
      if (error instanceof ContractError) {
        throw error;
      }
      throw new ContractError([{ path: [], code: "suite_module_load_failed" }]);
    }
    suite = parseSuite(moduleSuite(imported));
  } else if (extension === ".json" || extension === ".yaml" || extension === ".yml") {
    const content = await readSuiteFile(absolutePath);
    suite =
      extension === ".json"
        ? parseJson(EvalSuiteSchema, content)
        : parseYaml(EvalSuiteSchema, content);
  } else {
    throw new ContractError([{ path: [], code: "suite_format_unsupported" }]);
  }

  return resolveSuitePaths(suite, suiteDirectory);
}
