// SPDX-License-Identifier: Apache-2.0
/// <reference types="vite/client" />
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import "@harness/core";
import { listLogDefinitions, listSpanDefinitions } from "@harness/telemetry";
import {
  assertRandomStringsDroppedFromLog,
  assertRandomStringsDroppedFromSpan,
  assertRegisteredSchemasSafe,
} from "@harness/telemetry/testing";
import { beforeAll, describe, expect, it } from "vitest";

const productionModules = import.meta.glob("../packages/*/src/**/*.ts");
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

async function importProductionRegistrationSources(root: string): Promise<void> {
  for (const source of productionRegistrationSources(root)) {
    const modulePath = `../${source}`;
    const load = productionModules[modulePath];
    expect(
      load,
      `Production telemetry registration module ${source} must be importable`,
    ).toBeTypeOf("function");
    if (load === undefined) {
      throw new Error(`Production telemetry registration module ${source} is not importable`);
    }
    await load();
  }
}

describe("production telemetry definition catalog", () => {
  beforeAll(async () => {
    await importProductionRegistrationSources(process.cwd());
  });

  it("imports every production file that registers telemetry definitions", () => {
    const root = process.cwd();
    const sources = productionRegistrationSources(root);
    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) {
      expect(productionModules[`../${source}`]).toBeTypeOf("function");
    }
  });

  it("loads every known production span and SafeEvent log definition", () => {
    expect(
      listSpanDefinitions()
        .map(({ name }) => name)
        .sort(),
    ).toEqual(expectedSpanNames);
    expect(
      listLogDefinitions()
        .map(({ name }) => name)
        .sort(),
    ).toEqual(expectedLogNames);
    assertRegisteredSchemasSafe();
  });

  it("drops unsafe random strings from every production span", () => {
    for (const definition of listSpanDefinitions()) {
      expect(() => {
        assertRandomStringsDroppedFromSpan(definition);
      }).not.toThrow();
    }
  });

  it("drops unsafe random strings from every production log", async () => {
    for (const definition of listLogDefinitions()) {
      await expect(assertRandomStringsDroppedFromLog(definition)).resolves.toBeUndefined();
    }
  });
});
