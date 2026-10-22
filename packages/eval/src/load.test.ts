// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ContractError } from "@harness/schemas";
import { afterEach, describe, expect, it } from "vitest";
import { loadSuite } from "./load.js";

const directories: string[] = [];

async function createSuiteDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "eval-suite-"));
  directories.push(directory);
  return directory;
}

const task = {
  id: "synthetic_task",
  input: { goal: "Complete a synthetic task." },
  workspace: { fixtureDir: "./fixtures" },
  policyFile: "./policy.yaml",
  graders: [
    { type: "file_diff", path: "README.md", expectedFile: "./expected.txt" },
    { type: "schema_valid", schemaRef: "./schemas.ts#OutputSchema" },
  ],
  tags: ["synthetic"],
};

const jsonContent = JSON.stringify({ schemaVersion: 1, tasks: [task] });
const yamlContent = `schemaVersion: 1
tasks:
  - id: synthetic_task
    input:
      goal: Complete a synthetic task.
    workspace:
      fixtureDir: ./fixtures
    policyFile: ./policy.yaml
    graders:
      - type: file_diff
        path: README.md
        expectedFile: ./expected.txt
      - type: schema_valid
        schemaRef: ./schemas.ts#OutputSchema
    tags:
      - synthetic
`;

function requireContractError(error: unknown): ContractError {
  if (!(error instanceof ContractError)) {
    throw new Error("Expected a contract validation error.");
  }
  return error;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("loadSuite", () => {
  it.each([
    ["JSON", ".json", jsonContent],
    ["YAML", ".yaml", yamlContent],
  ])(
    "loads %s and resolves relative references from the suite file",
    async (_format, suffix, content) => {
      const directory = await createSuiteDirectory();
      const path = join(directory, `example${suffix}`);
      await writeFile(path, content, "utf8");

      const suite = await loadSuite(path);

      expect(suite.schemaVersion).toBe(1);
      expect(suite.tasks[0]?.workspace?.fixtureDir).toBe(resolve(directory, "fixtures"));
      expect(suite.tasks[0]?.policyFile).toBe(resolve(directory, "policy.yaml"));
      expect(suite.tasks[0]?.graders[0]).toMatchObject({
        type: "file_diff",
        path: "README.md",
        expectedFile: resolve(directory, "expected.txt"),
      });
      expect(suite.tasks[0]?.graders[1]).toEqual({
        type: "schema_valid",
        schemaRef: `${resolve(directory, "schemas.ts")}#OutputSchema`,
      });
    },
  );

  it("loads a TypeScript suite through dynamic import", async () => {
    const directory = await createSuiteDirectory();
    const path = join(directory, "example.suite.ts");
    await writeFile(path, `export default ${JSON.stringify({ schemaVersion: 1, tasks: [task] })};`);

    const suite = await loadSuite(path);

    expect(suite.tasks[0]?.id).toBe("synthetic_task");
    expect(suite.tasks[0]?.workspace?.fixtureDir).toBe(resolve(directory, "fixtures"));
  });

  it("loads a named suite export when there is no default export", async () => {
    const directory = await createSuiteDirectory();
    const path = join(directory, "example.suite.ts");
    await writeFile(
      path,
      `export const suite = ${JSON.stringify({ schemaVersion: 1, tasks: [task] })};`,
    );

    await expect(loadSuite(path)).resolves.toMatchObject({
      schemaVersion: 1,
      tasks: [{ id: "synthetic_task" }],
    });
  });

  it("preserves path-level validation errors from data suites", async () => {
    const directory = await createSuiteDirectory();
    const path = join(directory, "invalid.json");
    await writeFile(
      path,
      JSON.stringify({ schemaVersion: 1, tasks: [{ ...task, id: "Bad Code" }] }),
    );

    const error = requireContractError(await loadSuite(path).catch((caught: unknown) => caught));

    expect(error.issues).toContainEqual({ path: ["tasks", 0, "id"], code: "invalid_format" });
  });

  it("returns value-free errors for unreadable and unsupported suite files", async () => {
    const directory = await createSuiteDirectory();
    const missingPath = join(directory, "missing.json");
    const unsupportedPath = join(directory, "suite.txt");
    const readError = requireContractError(
      await loadSuite(missingPath).catch((error: unknown) => error),
    );
    const unsupportedError = requireContractError(
      await loadSuite(unsupportedPath).catch((error: unknown) => error),
    );

    expect(readError.issues).toEqual([{ path: [], code: "suite_file_unavailable" }]);
    expect(unsupportedError.issues).toEqual([{ path: [], code: "suite_format_unsupported" }]);
  });

  it("reports a safe issue when a TypeScript suite fails to load", async () => {
    const directory = await createSuiteDirectory();
    const path = join(directory, "invalid.suite.ts");
    await writeFile(path, `throw new Error("synthetic private content");`);

    const error = requireContractError(await loadSuite(path).catch((caught: unknown) => caught));

    expect(error.issues).toEqual([{ path: [], code: "suite_module_load_failed" }]);
    expect(error.message).not.toContain("synthetic private content");
  });

  it("uses the current directory option for relative suite paths", async () => {
    const directory = await createSuiteDirectory();
    const path = join(directory, "suite.json");
    await writeFile(path, jsonContent);

    await expect(loadSuite("suite.json", { cwd: directory })).resolves.toMatchObject({
      tasks: [{ id: "synthetic_task" }],
    });
  });

  it("rejects empty suite paths and malformed JSON with contract errors", async () => {
    const directory = await createSuiteDirectory();
    const path = join(directory, "invalid.json");
    await writeFile(path, "{");

    const pathError = requireContractError(await loadSuite("").catch((error: unknown) => error));
    const jsonError = requireContractError(await loadSuite(path).catch((error: unknown) => error));

    expect(pathError.issues).toEqual([{ path: [], code: "too_small" }]);
    expect(jsonError.issues).toEqual([{ path: [], code: "invalid_json" }]);
  });

  it("rejects oversized data suites while reading", async () => {
    const directory = await createSuiteDirectory();
    const path = join(directory, "large.json");
    await writeFile(path, " ".repeat(1_048_577), "utf8");

    const error = requireContractError(await loadSuite(path).catch((caught: unknown) => caught));

    expect(error.issues).toEqual([{ path: [], code: "size_limit_exceeded" }]);
  });

  it("can read the expected fixture path after resolution", async () => {
    const directory = await createSuiteDirectory();
    const path = join(directory, "suite.json");
    const expected = join(directory, "expected.txt");
    await writeFile(expected, "synthetic expected content", "utf8");
    await writeFile(path, jsonContent, "utf8");

    const suite = await loadSuite(path);
    const expectedFile = suite.tasks[0]?.graders[0];

    if (expectedFile?.type !== "file_diff" || expectedFile.expectedFile === undefined) {
      throw new Error("Expected the file diff grader to have a resolved expected file.");
    }
    await expect(readFile(expectedFile.expectedFile, "utf8")).resolves.toBe(
      "synthetic expected content",
    );
  });
});
