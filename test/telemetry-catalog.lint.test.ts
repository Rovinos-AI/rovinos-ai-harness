// SPDX-License-Identifier: Apache-2.0
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import "@harness/core";
import {
  listLogDefinitions,
  listSpanDefinitions,
} from "@harness/telemetry";
import {
  assertRandomStringsDroppedFromLog,
  assertRandomStringsDroppedFromSpan,
  assertRegisteredSchemasSafe,
} from "@harness/telemetry/testing";
import { describe, expect, it } from "vitest";

const catalogRegistrationModules = [
  "packages/core/src/spans.ts",
  "packages/telemetry/src/safe-event-logs.ts",
];
const expectedSpanNames = [
  "harness.approval_wait",
  "harness.checkpoint",
  "harness.compaction",
  "harness.model_call",
  "harness.run",
  "harness.tool_call",
];
const expectedLogNames = [
  "harness.safe.approval_wait",
  "harness.safe.budget_exceeded",
  "harness.safe.checkpoint",
  "harness.safe.model_call",
  "harness.safe.pii_action",
  "harness.safe.run_created",
  "harness.safe.run_status",
  "harness.safe.subagent_completed",
  "harness.safe.subagent_spawned",
  "harness.safe.tool_call",
];

function findRegistrationSources(directory: string, root: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return findRegistrationSources(path, root);
    }
    if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) {
      return [];
    }
    const source = readFileSync(path, "utf8");
    return /\b(?:defineSpan|defineLogRecord)\s*\(/u.test(source)
      ? [relative(root, path).replaceAll("\\", "/")]
      : [];
  });
}

function productionRegistrationSources(root: string): string[] {
  return readdirSync(join(root, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const sourceDirectory = join(root, "packages", entry.name, "src");
      return existsSync(sourceDirectory) ? findRegistrationSources(sourceDirectory, root) : [];
    })
    .sort();
}

describe("production telemetry definition catalog", () => {
  it("imports every production file that registers telemetry definitions", () => {
    const root = process.cwd();
    expect(productionRegistrationSources(root)).toEqual([...catalogRegistrationModules].sort());
  });

  it("loads every known production span and SafeEvent log definition", () => {
    expect(listSpanDefinitions().map(({ name }) => name).sort()).toEqual(expectedSpanNames);
    expect(listLogDefinitions().map(({ name }) => name).sort()).toEqual(expectedLogNames);
    assertRegisteredSchemasSafe();
  });

  for (const definition of listSpanDefinitions()) {
    it(`drops unsafe random strings from production span ${definition.name}`, () => {
      assertRandomStringsDroppedFromSpan(definition);
    });
  }

  for (const definition of listLogDefinitions()) {
    it(`drops unsafe random strings from production log ${definition.name}`, async () => {
      await assertRandomStringsDroppedFromLog(definition);
    });
  }
});
