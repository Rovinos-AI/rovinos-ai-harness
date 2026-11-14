// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SafeEvent, safeEventLogAttributeMap, type SafeEventType } from "@rovinos/telemetry";
import { kustoLogFixtureSchema, type KustoLogFixture } from "./query-contract.ts";

const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const fixturePath = resolve(root, "test/fixtures/kusto/safe-events.jsonl");
const eventTimestamp = Date.UTC(2026, 10, 13);
const traceId = "11111111111111111111111111111111";
const runId = "00000000000000000000000000";
const common = {
  runId,
  traceId,
  policyVersion: "sanitizer_v1",
};

function safeEvent(seq: number, fields: Readonly<Record<string, unknown>>): SafeEventType {
  return SafeEvent.parse({
    ...common,
    seq,
    ts: eventTimestamp + seq,
    spanId: seq.toString(16).padStart(16, "0"),
    ...fields,
  });
}

function createModelEvents(): readonly SafeEventType[] {
  return [
    safeEvent(1, {
      kind: "model_call",
      provider: "openai",
      model: "gpt_4",
      inputTokens: 1200,
      outputTokens: 300,
      latencyMs: 200,
      schemaValid: true,
      repairAttempts: 0,
      finishReason: "stop",
    }),
    safeEvent(2, {
      kind: "model_call",
      provider: "openai",
      model: "gpt_4",
      inputTokens: 1000,
      outputTokens: 200,
      latencyMs: 400,
      schemaValid: false,
      repairAttempts: 1,
      finishReason: "stop",
    }),
    safeEvent(3, {
      kind: "model_call",
      provider: "anthropic",
      model: "claude",
      inputTokens: 800,
      outputTokens: 100,
      latencyMs: 600,
      schemaValid: true,
      repairAttempts: 2,
      finishReason: "stop",
    }),
  ];
}

function createToolEvents(): readonly SafeEventType[] {
  return [
    safeEvent(4, {
      kind: "tool_call",
      toolId: "search",
      outcome: "timeout",
      latencyMs: 1000,
    }),
    safeEvent(5, {
      kind: "tool_call",
      toolId: "browser",
      outcome: "timeout",
      latencyMs: 2000,
    }),
    safeEvent(6, {
      kind: "tool_call",
      toolId: "search",
      outcome: "error",
      errorCode: "tool_failed",
      latencyMs: 50,
    }),
  ];
}

function createApprovalEvents(): readonly SafeEventType[] {
  return [
    safeEvent(7, {
      kind: "approval_wait",
      decision: "approve",
      decidedBy: "human",
      waitMs: 250,
    }),
    safeEvent(8, {
      kind: "approval_wait",
      decision: "deny",
      decidedBy: "policy",
      waitMs: 50,
    }),
    safeEvent(9, {
      kind: "approval_wait",
      decision: "edit",
      decidedBy: "expiry",
      waitMs: 500,
    }),
  ];
}

function createPiiEvents(): readonly SafeEventType[] {
  return [
    safeEvent(10, {
      kind: "pii_action",
      boundary: "tool_input",
      action: "redacted",
      entities: [
        { type: "email", count: 2 },
        { type: "phone", count: 1 },
      ],
    }),
    safeEvent(11, {
      kind: "pii_action",
      boundary: "telemetry_export",
      action: "blocked",
      entities: [{ type: "email", count: 1 }],
    }),
  ];
}

function createRunStatusEvents(): readonly SafeEventType[] {
  return [
    safeEvent(12, {
      kind: "run_status",
      from: "running",
      to: "completed",
      reason: "finished",
    }),
    safeEvent(13, {
      kind: "run_status",
      from: "running",
      to: "failed",
      reason: "model_error",
    }),
    safeEvent(14, {
      kind: "run_status",
      from: "suspended",
      to: "running",
      reason: "resumed",
    }),
    safeEvent(15, {
      kind: "run_status",
      from: "running",
      to: "cancelled",
      reason: "user_cancelled",
    }),
    safeEvent(16, {
      kind: "run_status",
      from: "running",
      to: "completed",
      reason: "finished",
    }),
  ];
}

function createEvents(): readonly SafeEventType[] {
  return [
    ...createModelEvents(),
    ...createToolEvents(),
    ...createApprovalEvents(),
    ...createPiiEvents(),
    ...createRunStatusEvents(),
  ];
}

function eventValue(event: SafeEventType, field: string): unknown {
  if (field !== "entities") {
    return Reflect.get(event, field);
  }
  const entities: unknown = Reflect.get(event, field);
  if (!Array.isArray(entities)) {
    return undefined;
  }
  return entities.reduce<number>((total, entity: unknown) => {
    if (typeof entity !== "object" || entity === null || !("count" in entity)) {
      return total;
    }
    const count: unknown = Reflect.get(entity, "count");
    return typeof count === "number" && Number.isSafeInteger(count) && count >= 0
      ? total + count
      : total;
  }, 0);
}

function eventAttributes(event: SafeEventType): Record<string, string | number | boolean> {
  const attributes: Record<string, string | number | boolean> = {};
  for (const [field, name] of Object.entries(safeEventLogAttributeMap[event.kind])) {
    const value = eventValue(event, field);
    if (
      typeof value === "string" ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    ) {
      attributes[name] = value;
    }
  }
  return attributes;
}

function toLogRow(event: SafeEventType): KustoLogFixture {
  const isoTimestamp = new Date(event.ts).toISOString();
  return kustoLogFixtureSchema.parse({
    Timestamp: isoTimestamp,
    ObservedTimestamp: isoTimestamp,
    TraceID: event.traceId,
    SpanID: event.spanId,
    SeverityText: "INFO",
    SeverityNumber: 9,
    Body: `harness.safe.${event.kind}`,
    ResourceAttributes: { "service.name": "harness" },
    LogsAttributes: eventAttributes(event),
  });
}

/** Builds deterministic HarnessLogs rows from validated synthetic SafeEvents. */
export function generateKustoFixtureJsonl(): string {
  const rows = createEvents().map(toLogRow);
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

/** Returns the digest used by the fixture determinism test. */
export function hashFixtureContents(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--check")) {
    throw new Error("invalid_arguments");
  }
  const contents = generateKustoFixtureJsonl();
  if (args.includes("--check")) {
    const existing = await readFile(fixturePath, "utf8").catch(() => "");
    if (existing !== contents) {
      process.stderr.write("kusto_fixture_drift\n");
      process.exitCode = 1;
    }
    return;
  }
  await mkdir(resolve(root, "test/fixtures/kusto"), { recursive: true });
  await writeFile(fixturePath, contents, "utf8");
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(() => {
    process.stderr.write("kusto_fixture_generation_failed\n");
    process.exitCode = 1;
  });
}
