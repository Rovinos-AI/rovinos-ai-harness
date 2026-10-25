// SPDX-License-Identifier: Apache-2.0
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJson } from "@rovinos/schemas";
import { expect, it } from "vitest";
import { z } from "zod";
import {
  runCollectorFixture,
  type CollectorFixtureOutput,
  type CollectorFixturePayload,
} from "../scripts/collector/allowlist-test-harness.js";
import { buildOtlpFixtures, createCanary } from "./fixtures/otlp.js";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const outputNames = ["traces", "logs", "metrics"] as const;
const allowedResourceAttributes = new Set([
  "harness.policy.version",
  "service.name",
  "service.version",
  "telemetry.sdk.language",
  "telemetry.sdk.name",
  "telemetry.sdk.version",
]);

interface ResourceAttribute {
  readonly key: string;
  readonly value: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseOutput(output: string): unknown[] {
  return output
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .map((line) => parseJson(z.unknown(), line));
}

function attributes(value: unknown): ResourceAttribute[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const attribute = isRecord(item) ? item : undefined;
      return typeof attribute?.key === "string"
        ? [{ key: attribute.key, value: attribute.value }]
        : [];
    });
  }
  const record = isRecord(value) ? value : undefined;
  return record === undefined
    ? []
    : Object.entries(record).map(([key, attributeValue]) => ({
        key,
        value: attributeValue,
      }));
}

function resourceAttributeGroups(value: unknown): ResourceAttribute[][] {
  if (Array.isArray(value)) {
    return value.flatMap(resourceAttributeGroups);
  }
  const record = isRecord(value) ? value : undefined;
  if (record === undefined) {
    return [];
  }
  const resource = isRecord(record.resource) ? record.resource : undefined;
  const current = resource === undefined ? [] : [attributes(resource.attributes)];
  return [
    ...current,
    ...Object.entries(record)
      .filter(([key]) => key !== "resource")
      .flatMap(([, child]) => resourceAttributeGroups(child)),
  ];
}

function attributeStringValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  const record = isRecord(value) ? value : undefined;
  return typeof record?.stringValue === "string" ? record.stringValue : undefined;
}

function findSpans(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.flatMap(findSpans);
  }
  const record = isRecord(value) ? value : undefined;
  if (record === undefined) {
    return [];
  }
  const spans = Array.isArray(record.spans)
    ? record.spans.flatMap((span) => (isRecord(span) ? [span] : []))
    : [];
  return [
    ...spans,
    ...Object.entries(record)
      .filter(([key]) => key !== "spans")
      .flatMap(([, child]) => findSpans(child)),
  ];
}

function readPolicyVersion(): string {
  const generated = readFileSync(
    join(root, "infra/collector/policy-version.generated.yaml"),
    "utf8",
  );
  const version = /^ {8}value: "([^"]+)"$/mu.exec(generated)?.[1];
  if (version === undefined) {
    throw new Error("Generated collector policy version is missing.");
  }
  return version;
}

function expectProtectedOutputs(outputs: CollectorFixtureOutput, canary: string): void {
  const allOutput = outputNames.map((name) => outputs[name]).join("\n");
  expect(outputs.traces).toContain("run.fixture");
  expect(outputs.traces).toContain("harness.run");
  expect(outputs.logs).toContain("harness.safe.run_created");
  expect(outputs.metrics).toContain("harness.model.tokens");
  for (const name of outputNames) {
    expect(outputs[name]).not.toContain(canary);
  }
  expect(allOutput).not.toContain("custom.note");
  expect(allOutput).not.toContain("http.url");
  expect(allOutput).not.toContain("exception.message");
  expect(allOutput).not.toContain("custom.unregistered.");
  expect(allOutput).not.toContain("free-text-");

  for (const name of outputNames) {
    const lines = parseOutput(outputs[name]);
    expect(lines.length).toBeGreaterThan(0);
    const groups = lines.flatMap(resourceAttributeGroups);
    expect(groups.length).toBeGreaterThan(0);
    for (const group of groups) {
      expect(group.map(({ key }) => key).every((key) => allowedResourceAttributes.has(key))).toBe(
        true,
      );
      const policy = group.find(({ key }) => key === "harness.policy.version");
      expect(attributeStringValue(policy?.value)).toBe(readPolicyVersion());
    }
    if (name === "traces") {
      const spans = lines.flatMap(findSpans);
      expect(spans.some((span) => span.name === "harness.run")).toBe(true);
      expect(spans.every((span) => !Array.isArray(span.events) || span.events.length === 0)).toBe(
        true,
      );
    }
  }
}

it("keeps forbidden OTLP attributes out of the file exporter and detects leaks without processors", async () => {
  const canary = createCanary(randomBytes(32).toString("hex"));
  const fixture = buildOtlpFixtures(canary);
  const payloads: CollectorFixturePayload[] = [
    { signal: "traces", body: JSON.stringify(fixture.traces) },
    { signal: "logs", body: JSON.stringify(fixture.logs) },
    { signal: "metrics", body: JSON.stringify(fixture.metrics) },
  ];
  for (const composePath of [
    "infra/compose/docker-compose.yml",
    "infra/compose/docker-compose.test.yml",
  ]) {
    expect(readFileSync(join(root, composePath), "utf8")).not.toContain(
      "collector-unfiltered.yaml",
    );
  }

  const suffix = String(process.pid);
  const protectedOutputs = await runCollectorFixture(
    `harness-collector-protected-${suffix}`,
    true,
    payloads,
  );
  expectProtectedOutputs(protectedOutputs, canary);

  const unfilteredOutputs = await runCollectorFixture(
    `harness-collector-unfiltered-${suffix}`,
    false,
    payloads,
  );
  expect(outputNames.every((name) => unfilteredOutputs[name].includes(canary))).toBe(true);
}, 90_000);
