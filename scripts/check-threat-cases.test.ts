// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
} from "./check-threat-cases.js";

const testFile = "scripts/ci/image-hardening.int.test.ts";
const activeCase: ThreatCase = {
  id: "T-01",
  title: "Runner cannot control the host container runtime",
  mitigationTask: "19.1",
  testFile,
  activeFromTask: "19.1",
};
const temporaryDirectories: string[] = [];

function validCatalog(): ThreatCase[] {
  return Array.from({ length: 19 }, (_, index) => {
    const taskId = index === 0 ? "19.1" : "19.2";
    return {
      id: `T-${String(index + 1).padStart(2, "0")}`,
      title: `Threat ${index + 1}`,
      mitigationTask: taskId,
      testFile,
      activeFromTask: taskId,
    };
  });
}

function createFixture(
  options: {
    readonly completed?: readonly string[];
    readonly testContents?: string;
    readonly otherFiles?: Readonly<Record<string, string>>;
  } = {},
): string {
  const root = mkdtempSync(join(tmpdir(), "check-threat-cases-"));
  temporaryDirectories.push(root);
  const catalogPath = join(root, "test/sandbox/cases.json");
  const progressPath = join(root, "docs/progress.json");
  mkdirSync(join(root, "test/sandbox"), { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(catalogPath, JSON.stringify(validCatalog()));
  writeFileSync(progressPath, JSON.stringify({ completed: options.completed ?? ["19.1"] }));

  const fixtureFiles: Record<string, string> = { ...options.otherFiles };
  if (options.testContents !== undefined) {
    fixtureFiles[testFile] = options.testContents;
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
  it("reports a missing declared test file separately from a missing reference", () => {
    expect(findThreatCoverageIssues([activeCase], new Set(["19.1"]), new Map())).toEqual([
      `Missing active threat test file '${testFile}' for T-01.`,
    ]);
    expect(
      findThreatCoverageIssues(
        [activeCase],
        new Set(["19.1"]),
        new Map([[testFile, "// threat: T-02\n"]]),
      ),
    ).toEqual([`Missing active threat test reference 'T-01' in '${testFile}'.`]);
  });

  it("skips threats whose mitigation task is not complete", () => {
    expect(findThreatCoverageIssues([activeCase], new Set(), new Map())).toEqual([]);
  });
});

describe("checkThreatCases", () => {
  it("checks markers in the declared nested test file, not unrelated source files", async () => {
    const root = createFixture({
      testContents: "// threat: T-01\n",
      otherFiles: {
        "packages/production.ts": "// threat: T-01\n",
        "test/unrelated.test.ts": "// threat: T-01\n",
      },
    });

    await expect(checkThreatCases(root)).resolves.toEqual([]);
  });

  it("ignores markers in other files when the declared test has no reference", async () => {
    const root = createFixture({
      testContents: "",
      otherFiles: {
        "packages/production.ts": "// threat: T-01\n",
        "test/unrelated.test.ts": "// threat: T-01\n",
      },
    });

    await expect(checkThreatCases(root)).resolves.toEqual([
      `Missing active threat test reference 'T-01' in '${testFile}'.`,
    ]);
  });

  it("reports a missing declared file even when another file references the threat", async () => {
    const root = createFixture({
      otherFiles: { "test/unrelated.test.ts": "// threat: T-01\n" },
    });

    await expect(checkThreatCases(root)).resolves.toEqual([
      `Missing active threat test file '${testFile}' for T-01.`,
    ]);
  });
});

describe("threat coverage CLI", () => {
  it("exits with an error when a completed threat has no declared test reference", () => {
    const root = createFixture({
      testContents: "// threat: T-02\n",
      otherFiles: { "test/unrelated.test.ts": "// threat: T-01\n" },
    });

    const result = runChecker(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("T-01");
    expect(result.stderr).toContain("Missing active threat test reference");
  });

  it("exits successfully when every active threat is referenced by its declared test", () => {
    const root = createFixture({ testContents: "// threat: T-01\n" });

    const result = runChecker(root);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });
});

describe("ThreatCaseSchema", () => {
  it("accepts the last currently defined sandbox task id", () => {
    expect(
      ThreatCaseSchema.safeParse({
        ...activeCase,
        mitigationTask: "19.10",
        activeFromTask: "19.10",
      }).success,
    ).toBe(true);
  });

  it.each(["18.1", "19.30"])("rejects nonexistent sandbox task id %s", (taskId) => {
    expect(
      ThreatCaseSchema.safeParse({
        ...activeCase,
        mitigationTask: taskId,
        activeFromTask: taskId,
      }).success,
    ).toBe(false);
  });

  it("requires activation to equal the mitigation task", () => {
    expect(ThreatCaseSchema.safeParse({ ...activeCase, activeFromTask: "19.2" }).success).toBe(
      false,
    );
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
