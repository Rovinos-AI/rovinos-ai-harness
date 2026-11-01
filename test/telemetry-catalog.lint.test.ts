// SPDX-License-Identifier: Apache-2.0
/// <reference types="vite/client" />
import "@rovinos/core";
import { listLogDefinitions, listSpanDefinitions } from "@rovinos/telemetry";
import {
  assertRandomStringsDroppedFromLog,
  assertRandomStringsDroppedFromSpan,
  assertRegisteredSchemasSafe,
} from "@rovinos/telemetry/testing";
import { findTelemetryRegistrationSources } from "../scripts/telemetry-registration-sources.js";
import { beforeAll, describe, expect, it } from "vitest";

const productionModules = import.meta.glob("../packages/*/src/**/*.ts");
const expectedSpanNames = [
  "harness.app_content",
  "harness.approval_wait",
  "harness.checkpoint",
  "harness.compaction",
  "harness.input_wait",
  "harness.model_call",
  "harness.replay",
  "harness.run",
  "harness.tool_call",
  "harness.ui.decision",
  "harness.ui.error",
  "harness.ui.input",
  "harness.ui.interaction",
  "harness.ui.render",
  "harness.ui_session",
  "mcp.client.call",
];
const expectedLogNames = [
  "harness.approval_app.operation",
  "harness.control_plane.operation",
  "harness.keys.rotated",
  "harness.model.pricing_cache_missing",
  "harness.model.pricing_missing",
  "harness.safe.approval_wait",
  "harness.safe.budget_exceeded",
  "harness.safe.checkpoint",
  "harness.safe.input_wait",
  "harness.safe.model_call",
  "harness.safe.pii_action",
  "harness.safe.policy_decision",
  "harness.safe.run_created",
  "harness.safe.run_status",
  "harness.safe.subagent_completed",
  "harness.safe.subagent_spawned",
  "harness.safe.tool_call",
  "harness.sentinel.trip",
  "harness.vault.mark_terminal_failed",
];

async function importProductionRegistrationSources(root: string): Promise<void> {
  for (const source of findTelemetryRegistrationSources(root)) {
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
    const sources = findTelemetryRegistrationSources(root);
    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) {
      expect(productionModules[`../${source}`]).toBeTypeOf("function");
    }
  });

  it("loads every known production span and log definition", () => {
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
