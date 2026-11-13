// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import { type TelemetryConfig } from "@rovinos/schemas";
import {
  AllowlistLogRecordProcessor,
  emitSafeEvent,
  SafeEvent,
  type SafeEventType,
} from "@rovinos/telemetry";
import {
  kustoLogFixtureSchema,
  type KustoLogFixture,
} from "./query-contract.ts";

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

function createEvents(): readonly SafeEventType[] {
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

function createTelemetryConfig(): TelemetryConfig {
  return {
    sentinel: { minValueLength: 6, enabled: false },
    correlation: { enabled: false },
    metrics: { enabled: true, ownership: "harness", maxSeries: 100 },
    sinks: [],
    unsafe: { allowContentSinks: false },
  };
}

function toLogRow(
  record: ReturnType<InMemoryLogRecordExporter["getFinishedLogRecords"]>[number],
): KustoLogFixture {
  const timestamp = record.attributes["harness.event.timestamp_ms"];
  if (
    typeof timestamp !== "number" ||
    typeof record.body !== "string" ||
    record.spanContext === undefined ||
    typeof record.severityNumber !== "number"
  ) {
    throw new TypeError("kusto_log_record_incomplete");
  }
  const isoTimestamp = new Date(timestamp).toISOString();
  return kustoLogFixtureSchema.parse({
    Timestamp: isoTimestamp,
    ObservedTimestamp: isoTimestamp,
    TraceID: record.spanContext.traceId,
    SpanID: record.spanContext.spanId,
    SeverityText: "INFO",
    SeverityNumber: record.severityNumber,
    Body: record.body,
    ResourceAttributes: record.resource.attributes,
    LogsAttributes: record.attributes,
  });
}

/** Builds deterministic Kusto log rows from SafeEvents through the registered log allowlist. */
export async function generateKustoFixtureJsonl(): Promise<string> {
  const exporter = new InMemoryLogRecordExporter();
  const provider = new LoggerProvider({
    resource: resourceFromAttributes({ "service.name": "harness" }),
    processors: [
      new AllowlistLogRecordProcessor(new SimpleLogRecordProcessor({ exporter }), {
        telemetry: createTelemetryConfig(),
      }),
    ],
  });
  try {
    const logger = provider.getLogger("@rovinos/telemetry");
    for (const event of createEvents()) {
      emitSafeEvent(logger, event);
    }
    await provider.forceFlush();
    const rows = exporter
      .getFinishedLogRecords()
      .sort((left, right) => {
        const leftSeq = left.attributes["harness.event.seq"];
        const rightSeq = right.attributes["harness.event.seq"];
        return Number(leftSeq) - Number(rightSeq);
      })
      .map(toLogRow);
    return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
  } finally {
    await provider.shutdown();
  }
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
  const contents = await generateKustoFixtureJsonl();
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
