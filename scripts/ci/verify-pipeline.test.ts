// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { parse } from "yaml";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function readPipeline(): Record<string, unknown> {
  const pipeline: unknown = parse(readFileSync(resolve(root, "azure-pipelines.yml"), "utf8"));
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

  expect(pipeline.pr).toEqual(["main"]);
});

it("runs static checks before unit tests", () => {
  const stages = readStages(readPipeline());

  expect(
    stages
      .filter(isRecord)
      .map((stage) => stage.stage)
      .filter((stage): stage is string => typeof stage === "string"),
  ).toEqual(["static", "unit"]);

  const staticSteps = readSteps(findStage(stages, "static"));
  expect(
    staticSteps.some(
      (step) => typeof step.script === "string" && step.script.includes("yarn check:agents"),
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
  expect(runTests?.script).toContain("--coverage.reporter=cobertura");
  expect(publishResults).toBeDefined();
  expect(publishResults?.condition).toContain("succeededOrFailed()");
  expect(
    isRecord(publishCoverage?.inputs) ? publishCoverage.inputs.summaryFileLocation : undefined,
  ).toContain("cobertura-coverage.xml");
});

it("contains no secret-looking literals", () => {
  const pipeline = readFileSync(resolve(root, "azure-pipelines.yml"), "utf8");
  expect(pipeline).not.toMatch(
    /(?:gh[pousr]_[A-Z0-9]{20,}|AKIA[A-Z0-9]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:password|secret|api[_-]?key)\s*[:=]\s*['"]?[A-Z0-9+/]{12,})/i,
  );
});
