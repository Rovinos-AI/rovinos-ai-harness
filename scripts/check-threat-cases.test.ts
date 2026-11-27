// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkThreatCases,
  findThreatCoverageIssues,
  ThreatCaseSchema,
  ThreatCasesSchema,
  type ThreatCase,
} from "./check-threat-cases.ts";

const testFile = "scripts/ci/image-hardening.int.test.ts";
const activeCase: ThreatCase = {
  id: "T-01",
  title: "Runner cannot control the host container runtime",
  testFile,
  testName: "Threat 1",
};
const temporaryDirectories: string[] = [];

function validCatalog(): ThreatCase[] {
  return Array.from({ length: 19 }, (_, index) => ({
    id: `T-${String(index + 1).padStart(2, "0")}`,
    title: `Threat ${String(index + 1)}`,
    testFile,
    testName: `Threat ${String(index + 1)}`,
  }));
}

function fixtureTestContents(
  options: {
    readonly missingTestName?: string;
    readonly missingMarkerId?: string;
  } = {},
): string {
  return validCatalog()
    .filter(({ testName }) => testName !== options.missingTestName)
    .map(
      ({ id, testName }) =>
        `it(${JSON.stringify(testName)}, () => {${id === options.missingMarkerId ? "" : `\n  // threat: ${id}`}\n});`,
    )
    .join("\n");
}

function createFixture(
  options: {
    readonly testContents?: string | null;
    readonly otherFiles?: Readonly<Record<string, string>>;
  } = {},
): string {
  const root = mkdtempSync(join(tmpdir(), "check-threat-cases-"));
  temporaryDirectories.push(root);
  const catalogPath = join(root, "test/sandbox/cases.json");
  mkdirSync(join(root, "test/sandbox"), { recursive: true });
  writeFileSync(catalogPath, JSON.stringify(validCatalog()));

  const fixtureFiles: Record<string, string> = { ...options.otherFiles };
  if (options.testContents !== null) {
    fixtureFiles[testFile] = options.testContents ?? fixtureTestContents();
  }
  for (const [path, contents] of Object.entries(fixtureFiles)) {
    const filePath = join(root, path);
    mkdirSync(join(filePath, ".."), { recursive: true });
    writeFileSync(filePath, contents);
  }
  return root;
}

function runChecker(root: string): ReturnType<typeof spawnSync> {
  const script = fileURLToPath(new URL("./check-threat-cases.ts", import.meta.url));
  return spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", script, root],
    { cwd: root, encoding: "utf8" },
  );
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("findThreatCoverageIssues", () => {
  it("reports a missing test file and a missing threat marker", () => {
    expect(findThreatCoverageIssues([activeCase], new Map())).toEqual([
      `Missing threat test file '${testFile}' for T-01.`,
    ]);
    expect(
      findThreatCoverageIssues(
        [{ ...activeCase, testName: "Coverage test" }],
        new Map([[testFile, 'it("Coverage test", () => {});\n']]),
      ),
    ).toEqual([`Missing threat test reference 'T-01' in '${testFile}' for 'Coverage test'.`]);
  });

  it("reports a missing named test even when the file contains the threat marker", () => {
    expect(
      findThreatCoverageIssues(
        [activeCase],
        new Map([[testFile, "// threat: T-01\nit('Another test', () => {});\n"]]),
      ),
    ).toEqual([`Missing threat test 'Threat 1' in '${testFile}' for T-01.`]);
  });
});

describe("checkThreatCases", () => {
  it("does not read a progress JSON file or require task markers", async () => {
    const root = createFixture();
    const progressJson = join(root, "docs", "progress.json");
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(progressJson, "not json");

    await expect(checkThreatCases(root)).resolves.toEqual([]);
  });

  it("checks named tests in the declared test file, not unrelated source files", async () => {
    const root = createFixture({
      testContents: fixtureTestContents(),
      otherFiles: {
        "packages/production.ts": "// threat: T-01\n",
        "test/unrelated.test.ts": "// threat: T-01\n",
      },
    });

    await expect(checkThreatCases(root)).resolves.toEqual([]);
  });

  it("ignores markers in other files when the named test has no reference", async () => {
    const root = createFixture({
      testContents: fixtureTestContents({ missingMarkerId: "T-01" }),
      otherFiles: {
        "packages/production.ts": "// threat: T-01\n",
        "test/unrelated.test.ts": "// threat: T-01\n",
      },
    });

    await expect(checkThreatCases(root)).resolves.toEqual([
      `Missing threat test reference 'T-01' in '${testFile}' for 'Threat 1'.`,
    ]);
  });

  it("reports a missing named test even when another file references the threat", async () => {
    const root = createFixture({
      testContents: fixtureTestContents({ missingTestName: "Threat 1" }),
      otherFiles: { "test/unrelated.test.ts": "// threat: T-01\n" },
    });

    await expect(checkThreatCases(root)).resolves.toEqual([
      `Missing threat test 'Threat 1' in '${testFile}' for T-01.`,
    ]);
  });
});

describe("threat coverage CLI", () => {
  it("exits with an error when a named test has no threat marker", () => {
    const root = createFixture({
      testContents: fixtureTestContents({ missingMarkerId: "T-01" }),
      otherFiles: { "test/unrelated.test.ts": "// threat: T-01\n" },
    });

    const result = runChecker(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("T-01");
    expect(result.stderr).toContain("Missing threat test reference");
  });

  it("exits successfully when every named threat test has its marker", () => {
    const root = createFixture();

    const result = runChecker(root);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });
});

describe("task progress markers", () => {
  it("allows parallel task additions to merge without conflicts", () => {
    const root = mkdtempSync(join(tmpdir(), "task-progress-"));
    temporaryDirectories.push(root);
    const runGit = (...args: string[]): void => {
      const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
      if (result.status !== 0) {
        throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
      }
    };

    runGit("init", "--quiet");
    runGit("config", "user.name", "Task progress test");
    runGit("config", "user.email", "task-progress@example.invalid");
    runGit("checkout", "-b", "main");
    mkdirSync(join(root, "docs/progress"), { recursive: true });
    writeFileSync(join(root, "docs/progress/1.24"), "");
    runGit("add", "docs/progress/1.24");
    runGit("commit", "--quiet", "-m", "baseline");

    runGit("checkout", "-b", "task-one");
    writeFileSync(join(root, "docs/progress/1.25"), "");
    runGit("add", "docs/progress/1.25");
    runGit("commit", "--quiet", "-m", "complete task one");

    runGit("checkout", "main");
    runGit("checkout", "-b", "task-two");
    writeFileSync(join(root, "docs/progress/1.26"), "");
    runGit("add", "docs/progress/1.26");
    runGit("commit", "--quiet", "-m", "complete task two");
    runGit("merge", "--quiet", "--no-edit", "task-one");

    expect(readFileSync(join(root, "docs/progress/1.25"), "utf8")).toBe("");
    expect(readFileSync(join(root, "docs/progress/1.26"), "utf8")).toBe("");
  });
});

describe("ThreatCaseSchema", () => {
  it("requires a test name", () => {
    const { testName: _testName, ...missingTestName } = activeCase;
    expect(ThreatCaseSchema.safeParse(missingTestName).success).toBe(false);
  });

  it("accepts only test-file names", () => {
    expect(
      ThreatCaseSchema.safeParse({ ...activeCase, testFile: "packages/sandbox/src/run.ts" })
        .success,
    ).toBe(false);
  });
});

describe("ThreatCasesSchema", () => {
  it("accepts all 19 ordered threat identifiers", () => {
    expect(ThreatCasesSchema.safeParse(validCatalog()).success).toBe(true);
  });

  it.each([
    ["a removed threat", validCatalog().filter(({ id }) => id !== "T-07")],
    [
      "a renumbered threat",
      validCatalog().map((threatCase, index) =>
        index === 6 ? { ...threatCase, id: "T-20" } : threatCase,
      ),
    ],
    ["threats in the wrong order", validCatalog().reverse()],
  ])("rejects %s", (_description, cases) => {
    expect(ThreatCasesSchema.safeParse(cases).success).toBe(false);
  });

  it("rejects duplicate threat ids", () => {
    expect(ThreatCasesSchema.safeParse([...validCatalog(), activeCase]).success).toBe(false);
  });
});
