// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { parseYaml } from "@harness/schemas";
import { z } from "zod";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const pipelineSchema = z.looseObject({
  trigger: z.literal("none").optional(),
  pr: z
    .looseObject({
      autoCancel: z.boolean(),
      drafts: z.boolean(),
      branches: z.looseObject({ include: z.array(z.string()) }),
    })
    .optional(),
  stages: z.array(
    z.looseObject({
      stage: z.string(),
      jobs: z.array(
        z.looseObject({
          steps: z.array(z.record(z.string(), z.unknown())).optional(),
        }),
      ),
    }),
  ),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function readPipeline(): Record<string, unknown> {
  const pipeline = parseYaml(
    pipelineSchema,
    readFileSync(resolve(root, "azure-pipelines.yml"), "utf8"),
  );
  if (!isRecord(pipeline)) {
    throw new TypeError("Pipeline YAML must contain an object.");
  }
  return pipeline;
}

function readStages(pipeline: Record<string, unknown>): unknown[] {
  const stages = pipeline.stages;
  if (!isUnknownArray(stages)) {
    throw new TypeError("Pipeline YAML must contain a stages array.");
  }
  return stages;
}

function findStage(stages: unknown[], name: string): Record<string, unknown> {
  const stage = stages.find((candidate) => isRecord(candidate) && candidate.stage === name);
  if (!isRecord(stage)) {
    throw new TypeError(`Pipeline must contain the ${name} stage.`);
  }
  return stage;
}

function readSteps(stage: Record<string, unknown>): Record<string, unknown>[] {
  const steps = stage.jobs;
  if (!isUnknownArray(steps) || !isRecord(steps[0])) {
    throw new TypeError("Pipeline stages must contain a job.");
  }
  const jobSteps = steps[0].steps;
  if (!isUnknownArray(jobSteps) || !jobSteps.every(isRecord)) {
    throw new TypeError("Pipeline jobs must contain a steps array.");
  }
  return jobSteps;
}

it("enables pull request validation on main", () => {
  const pipeline = readPipeline();

  expect(pipeline.pr).toEqual({ autoCancel: true, drafts: false, branches: { include: ["main"] } });
  expect(pipeline.trigger).toBe("none");
});

it("runs static checks before tests and executes the release gates", () => {
  const stages = readStages(readPipeline());

  expect(
    stages
      .filter(isRecord)
      .map((stage) => stage.stage)
      .filter((stage): stage is string => typeof stage === "string"),
  ).toEqual(["static", "unit", "integration", "gates"]);

  const staticSteps = readSteps(findStage(stages, "static"));
  expect(
    staticSteps.some(
      (step) => typeof step.script === "string" && step.script.includes("yarn check:agents"),
    ),
  ).toBe(true);
  expect(
    staticSteps.some(
      (step) => typeof step.script === "string" && step.script.includes("yarn check:spdx"),
    ),
  ).toBe(true);
  expect(
    staticSteps.some(
      (step) => typeof step.script === "string" && step.script.includes("yarn check:licenses"),
    ),
  ).toBe(true);
  expect(
    staticSteps.some(
      (step) =>
        typeof step.script === "string" &&
        step.script.includes("node packages/cli/dist/bin.js policy test"),
    ),
  ).toBe(true);
  expect(
    staticSteps.some(
      (step) =>
        typeof step.script === "string" &&
        step.script.includes("node packages/cli/dist/bin.js policy lint"),
    ),
  ).toBe(true);
  const dcoStep = staticSteps.find(
    (step) => typeof step.script === "string" && step.script.includes("yarn check:dco"),
  );
  expect(dcoStep?.condition).toBe("eq(variables['Build.Reason'], 'PullRequest')");
  expect(dcoStep?.env).toEqual({ TARGET_BRANCH: "$(System.PullRequest.TargetBranch)" });
  expect(staticSteps.some((step) => step.checkout === "self" && step.fetchDepth === 0)).toBe(true);

  const gatesStage = findStage(stages, "gates");
  expect(gatesStage.dependsOn).toBe("integration");
  expect(
    readSteps(gatesStage).some(
      (step) => typeof step.script === "string" && step.script.includes("yarn test:canary"),
    ),
  ).toBe(true);
});

it("publishes JUnit results after success or failure", () => {
  const stages = readStages(readPipeline());
  const unitSteps = readSteps(findStage(stages, "unit"));
  const runTests = unitSteps.find(
    (step) => typeof step.script === "string" && step.script.includes("yarn test:unit"),
  );
  const publishResults = unitSteps.find((step) => step.task === "PublishTestResults@2");
  const publishCoverage = unitSteps.find((step) => step.task === "PublishCodeCoverageResults@2");

  expect(runTests?.script).toContain("--reporter=junit");
  expect(runTests?.script).toContain("--coverage.reportOnFailure");
  expect(runTests?.script).toContain("--coverage.reporter=cobertura");
  expect(publishResults).toBeDefined();
  expect(publishResults?.condition).toContain("succeededOrFailed()");
  expect(
    isRecord(publishCoverage?.inputs) ? publishCoverage.inputs.summaryFileLocation : undefined,
  ).toContain("cobertura-coverage.xml");
});

it("runs integration tests with Compose and always tears down", () => {
  const stages = readStages(readPipeline());
  const integrationStage = findStage(stages, "integration");
  const integrationSteps = readSteps(integrationStage);

  expect(statSync(resolve(root, "scripts/ci/compose-wait.sh")).mode & 0o111).not.toBe(0);
  expect(integrationStage.dependsOn).toBe("unit");
  expect(
    integrationSteps.some(
      (step) => typeof step.bash === "string" && step.bash.includes("compose-wait.sh"),
    ),
  ).toBe(true);
  const runTests = integrationSteps.find(
    (step) => typeof step.script === "string" && step.script.includes("yarn test:integration"),
  );
  expect(runTests?.script).toContain("--reporter=junit");
  expect(runTests?.script).toContain("integration-junit.xml");
  expect(runTests?.env).toMatchObject({
    TEST_POSTGRES_URL: "postgresql://harness@127.0.0.1:5432/harness",
  });
  expect(
    integrationSteps.some(
      (step) => typeof step.script === "string" && step.script.includes("yarn build:schemas"),
    ),
  ).toBe(true);
  expect(
    integrationSteps.some(
      (step) => step.task === "PublishTestResults@2" && step.condition === "succeededOrFailed()",
    ),
  ).toBe(true);
  const collectLogs = integrationSteps.find(
    (step) => typeof step.bash === "string" && step.bash.includes("logs --no-color"),
  );
  expect(collectLogs?.condition).toBe("failed()");
  expect(collectLogs?.bash).toContain("compose.log");
  expect(
    integrationSteps.some(
      (step) =>
        step.task === "PublishBuildArtifacts@1" &&
        step.condition === "failed()" &&
        isRecord(step.inputs) &&
        step.inputs.PathtoPublish === "$(Build.ArtifactStagingDirectory)/compose.log",
    ),
  ).toBe(true);
  expect(
    integrationSteps.some(
      (step) =>
        typeof step.bash === "string" &&
        step.bash.includes("docker compose") &&
        step.bash.includes("down -v") &&
        step.condition === "always()",
    ),
  ).toBe(true);
});

it("enforces package source line coverage per file", () => {
  const config = readFileSync(resolve(root, "vitest.config.ts"), "utf8");

  expect(config).toContain('provider: "v8"');
  expect(config).toContain('"packages/*/src/**/*.ts"');
  expect(config).toContain('"packages/sandbox/runner/src/**/*.ts"');
  expect(config).toContain(
    '"packages/sandbox/egress-proxy/src/**/*.ts"',
  );
  expect(config).toContain("perFile: true");
  expect(config).toContain("lines: 85");
  expect(config).toContain("reportOnFailure: true");
});

it("fails when a package source file falls below the coverage floor", () => {
  const temporaryRoot = mkdtempSync(resolve(root, ".coverage-fixture-"));
  const sourceDirectory = resolve(temporaryRoot, "packages/coverage-fixture/src");
  const configPath = resolve(temporaryRoot, "vitest.config.mjs");
  const rootConfigUrl = new URL("../../vitest.config.ts", import.meta.url).href;

  try {
    mkdirSync(sourceDirectory, { recursive: true });
    writeFileSync(
      resolve(sourceDirectory, "index.ts"),
      "export function uncovered(): void { return; }\n",
    );
    writeFileSync(resolve(sourceDirectory, "index.test.ts"), 'test("fixture", () => {});\n');
    writeFileSync(
      configPath,
      `import rootConfig from ${JSON.stringify(rootConfigUrl)};\n` +
        `export default { ...rootConfig, root: ${JSON.stringify(temporaryRoot)}, test: { ...rootConfig.test, projects: [{ extends: true, test: { name: "coverage-fixture", globals: true, include: ["packages/coverage-fixture/src/*.test.ts"] } }], coverage: { ...rootConfig.test.coverage, reportsDirectory: ${JSON.stringify(resolve(temporaryRoot, "coverage"))} } } };\n`,
    );

    const result = spawnSync(
      process.execPath,
      [
        resolve(root, "node_modules/vitest/vitest.mjs"),
        "run",
        "--config",
        configPath,
        "--coverage",
      ],
      { cwd: temporaryRoot, encoding: "utf8", timeout: 60_000 },
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("Coverage for lines");
    expect(`${result.stdout}\n${result.stderr}`).toContain("does not meet");
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

it("verifies pinned mise and Yarn toolchain paths", () => {
  const template = readFileSync(resolve(root, "pipelines/templates/node-setup.yml"), "utf8");
  const nodePathLine = template.indexOf("$(mise where node)/bin");
  const corepackPathLine = template.indexOf("$(mise where npm:corepack)/bin");

  expect(template).not.toContain("https://mise.run");
  expect(template).toContain("MISE_VERSION=v2026.10.4");
  expect(template).toContain(
    "MISE_SHA256=2fc793020b442d08163603400236b2c693f8cede810c7e432fc77220e6c9e8a1",
  );
  expect(nodePathLine).toBeGreaterThanOrEqual(0);
  expect(corepackPathLine).toBeGreaterThan(nodePathLine);
  expect(template).toContain("yarn --version");
  expect(template).toContain("match(/^yarn@([^+]+)/)");
  expect(template).toContain('if [ "$actual_yarn_version" != "$expected_yarn_version" ]');
});

it("caches Yarn's global package cache", () => {
  const pipeline = readFileSync(resolve(root, "azure-pipelines.yml"), "utf8");
  const setupTemplate = readFileSync(resolve(root, "pipelines/templates/node-setup.yml"), "utf8");

  expect(pipeline).toContain("YARN_GLOBAL_FOLDER: $(Pipeline.Workspace)/.yarn");
  expect(setupTemplate).toContain('mkdir -p "$YARN_GLOBAL_FOLDER/cache"');
  expect(setupTemplate).toContain("path: $(YARN_GLOBAL_FOLDER)/cache");
});

it("contains no secret-looking literals", () => {
  const pipeline = readFileSync(resolve(root, "azure-pipelines.yml"), "utf8");
  expect(pipeline).not.toMatch(
    /(?:gh[pousr]_[A-Z0-9]{20,}|AKIA[A-Z0-9]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:password|secret|api[_-]?key)\s*[:=]\s*['"]?[A-Z0-9+/]{12,})/i,
  );
});
