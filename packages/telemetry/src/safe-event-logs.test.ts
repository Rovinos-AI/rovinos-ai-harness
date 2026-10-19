// SPDX-License-Identifier: Apache-2.0
import { trace } from "@opentelemetry/api";
import { SeverityNumber, type Logger, type LogRecord } from "@opentelemetry/api-logs";
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { Code, Id, type TelemetryConfig } from "@harness/schemas";
import { describe, expect, it, vi } from "vitest";
import { listLogDefinitions } from "./log-registry.js";
import { AllowlistLogRecordProcessor } from "./processors/allowlist-log-processor.js";
import { SafeEvent } from "./safe-event.js";
import {
  emitKeysRotated,
  emitSafeEvent,
  emitPricingMissing,
  emitVaultMarkTerminalFailed,
  safeEventLogAttributeMap,
} from "./safe-event-logs.js";
import { emitApprovalAppAudit } from "./approval-app-audit.js";

const common = {
  runId: "00000000000000000000000000",
  seq: 12,
  ts: 1730000000000,
  traceId: "11111111111111111111111111111111",
  spanId: "2222222222222222",
  policyVersion: "sanitizer_v1",
};

const events = [
  SafeEvent.parse({
    ...common,
    kind: "model_call",
    provider: "openai",
    model: "gpt_4",
    inputTokens: 5,
    outputTokens: 8,
    latencyMs: 10,
    schemaValid: true,
    repairAttempts: 0,
    finishReason: "stop",
  }),
  SafeEvent.parse({
    ...common,
    kind: "tool_call",
    toolId: "search",
    outcome: "ok",
    errorCode: "tool_error",
    latencyMs: 10,
  }),
  SafeEvent.parse({
    ...common,
    kind: "policy_decision",
    toolId: "search",
    policyDecision: "allow",
    ruleId: "policy.rule",
  }),
  SafeEvent.parse({
    ...common,
    kind: "approval_wait",
    decision: "approve",
    decidedBy: "human",
    reason: "approved",
    waitMs: 10,
  }),
  SafeEvent.parse({ ...common, kind: "checkpoint", atSeq: 11, hasWorkspaceRef: true }),
  SafeEvent.parse({
    ...common,
    kind: "run_status",
    from: "running",
    to: "completed",
    reason: "finished",
  }),
  SafeEvent.parse({
    ...common,
    kind: "pii_action",
    boundary: "tool_input",
    action: "detokenized",
    entities: [
      { type: "email", count: 2 },
      { type: "phone", count: 3 },
    ],
  }),
  SafeEvent.parse({
    ...common,
    kind: "pii_action",
    boundary: "telemetry_export",
    action: "blocked",
    entities: [{ type: "email", count: 1 }],
  }),
  SafeEvent.parse({
    ...common,
    kind: "budget_exceeded",
    budget: "cost",
    limit: 2.5,
    observed: 3,
  }),
  SafeEvent.parse({
    ...common,
    kind: "subagent_spawned",
    childRunId: "00000000000000000000000001",
    role: "researcher",
    parentCallId: "00000000000000000000000002",
  }),
  SafeEvent.parse({
    ...common,
    kind: "subagent_completed",
    childRunId: "00000000000000000000000001",
    outcome: "completed",
    inputTokens: 4,
    outputTokens: 2,
    costMicros: 3,
  }),
  SafeEvent.parse({ ...common, kind: "run_created", configHash: "a".repeat(64) }),
];

describe("SafeEvent log projection", () => {
  it("emits approval operation audit metadata through its registered log record", () => {
    const emit = vi.fn<(record: LogRecord) => void>();
    const logger = { emit, enabled: () => true } satisfies Logger;

    emitApprovalAppAudit(
      {
        tokenId: Code.parse("token.test"),
        tool: Code.parse("harness.approvals.reveal"),
        outcome: Code.parse("ok"),
        count: 2,
      },
      logger,
    );

    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "harness.approval_app.operation",
        attributes: {
          "harness.auth.token.id": "token.test",
          "harness.approval.tool": "harness.approvals.reveal",
          "harness.approval.outcome": "ok",
          "harness.approval.value_count": 2,
        },
      }),
    );
  });

  it("emits registered key-rotation counts only", () => {
    const emit = vi.fn<(record: LogRecord) => void>();
    const logger = { emit, enabled: () => true } satisfies Logger;

    emitKeysRotated({ vault: 2, store: 3 }, logger);

    const record = emit.mock.calls[0]?.[0];
    expect(record?.eventName).toBe("harness.keys.rotated");
    expect(record?.severityNumber).toBe(SeverityNumber.INFO);
    expect(record?.attributes).toEqual({
      "harness.keys.vault.rows_rotated": 2,
      "harness.keys.store.rows_rotated": 3,
    });
  });

  it("emits terminal vault failures with only the run id and error code", () => {
    const emit = vi.fn<(record: LogRecord) => void>();
    const logger = { emit, enabled: () => true } satisfies Logger;
    const runId = Id.parse("00000000000000000000000000");

    emitVaultMarkTerminalFailed(runId, Code.parse("vault_unavailable"), logger);

    const record = emit.mock.calls[0]?.[0];
    expect(record?.body).toBe("vault_mark_terminal_failed");
    expect(record?.eventName).toBe("harness.vault.mark_terminal_failed");
    expect(record?.severityNumber).toBe(SeverityNumber.ERROR);
    expect(record?.attributes).toEqual({
      "harness.run.id": runId,
      "harness.error.code": "vault_unavailable",
    });
  });

  it("emits missing model pricing as a bounded provider/model diagnostic", () => {
    const emit = vi.fn<(record: LogRecord) => void>();
    const logger = { emit, enabled: () => true } satisfies Logger;

    emitPricingMissing(Code.parse("sample"), Code.parse("model_a"), logger);

    const record = emit.mock.calls[0]?.[0];
    expect(record?.body).toBe("pricing_missing");
    expect(record?.eventName).toBe("harness.model.pricing_missing");
    expect(record?.severityNumber).toBe(SeverityNumber.WARN);
    expect(record?.attributes).toEqual({
      "harness.model.provider": "sample",
      "harness.model.name": "model_a",
    });
  });

  it.each(events)("registers and emits every SafeEvent kind with its mapped fields", (event) => {
    const emit = vi.fn<(record: LogRecord) => void>();
    const logger = { emit, enabled: () => true } satisfies Logger;

    emitSafeEvent(logger, event);

    const record = emit.mock.calls[0]?.[0];
    expect(record?.body).toBe(event.kind);
    expect(record?.eventName).toBe(`harness.safe.${event.kind}`);
    expect(record?.severityNumber).toBe(SeverityNumber.INFO);
    expect(Object.keys(record?.attributes ?? {}).sort()).toEqual(
      Object.values(safeEventLogAttributeMap[event.kind]).sort(),
    );
    expect(record?.attributes?.["harness.trace.id"]).toBe(event.traceId);
    expect(record?.attributes?.["harness.span.id"]).toBe(event.spanId);
    const spanContext =
      record?.context === undefined ? undefined : trace.getSpanContext(record.context);
    expect(spanContext).toMatchObject({ traceId: event.traceId, spanId: event.spanId });
    const entityCount =
      event.kind === "pii_action" ? record?.attributes?.["harness.pii.entity_count"] : undefined;
    const expectedEntityCount =
      event.kind === "pii_action"
        ? event.entities.reduce((total, entity) => total + entity.count, 0)
        : undefined;
    expect(entityCount).toBe(expectedEntityCount);
  });

  it("omits absent optional fields and aggregates PII entity counts", () => {
    const emit = vi.fn<(record: LogRecord) => void>();
    const logger = { emit, enabled: () => true } satisfies Logger;
    const event = SafeEvent.parse({
      ...common,
      kind: "tool_call",
      toolId: "search",
      outcome: "ok",
      latencyMs: 2,
    });

    emitSafeEvent(logger, event);

    expect(emit.mock.calls[0]?.[0].attributes).not.toHaveProperty("harness.error.code");
  });

  it("uses the allowlist processor before the real log exporter", async () => {
    const exporter = new InMemoryLogRecordExporter();
    const processor = new AllowlistLogRecordProcessor(new SimpleLogRecordProcessor({ exporter }), {
      telemetry: {
        sentinel: { minValueLength: 6, enabled: false },
        correlation: { enabled: false },
      } satisfies TelemetryConfig,
    });
    const provider = new LoggerProvider({
      resource: resourceFromAttributes({
        "service.name": "harness",
        "service.version": "1.0.0",
        "harness.policy.version": "2",
        "telemetry.sdk.name": "opentelemetry",
        "telemetry.sdk.language": "nodejs",
        "telemetry.sdk.version": "2.12.0",
        "host.name": "private-host",
      }),
      processors: [processor],
    });
    const logger = provider.getLogger("@harness/telemetry");

    try {
      const [modelEvent] = events;
      if (modelEvent === undefined) {
        throw new Error("Expected model SafeEvent fixture.");
      }
      emitSafeEvent(logger, modelEvent);
      await provider.forceFlush();

      const [exported] = exporter.getFinishedLogRecords();
      expect(exported?.body).toBe("harness.safe.model_call");
      expect(exported?.severityText).toBeUndefined();
      expect(exported?.attributes["harness.trace.id"]).toBe(common.traceId);
      expect(exported?.attributes["harness.span.id"]).toBe(common.spanId);
      expect(exported?.spanContext).toMatchObject({
        traceId: common.traceId,
        spanId: common.spanId,
      });
      expect(exported?.resource.attributes).toEqual({
        "service.name": "harness",
        "service.version": "1.0.0",
        "harness.policy.version": "2",
        "telemetry.sdk.name": "opentelemetry",
        "telemetry.sdk.language": "nodejs",
        "telemetry.sdk.version": "2.12.0",
      });
      expect(JSON.stringify(exported)).not.toContain("sensitive free-form body");
    } finally {
      await provider.shutdown();
    }
  });

  it("registers one definition for every safe kind and rejects invalid input", () => {
    expect(
      listLogDefinitions()
        .map(({ name }) => name)
        .filter((name) => name.startsWith("harness.safe."))
        .sort(),
    ).toEqual([...new Set(events.map(({ kind }) => `harness.safe.${kind}`))].sort());
    expect(listLogDefinitions().map(({ name }) => name)).toContain("harness.sentinel.trip");
    expect(listLogDefinitions().map(({ name }) => name)).toContain("harness.keys.rotated");
    expect(listLogDefinitions().map(({ name }) => name)).toContain(
      "harness.vault.mark_terminal_failed",
    );
    const logger = {
      emit: vi.fn<(record: LogRecord) => void>(),
      enabled: () => true,
    } satisfies Logger;
    expect(() => {
      Reflect.apply(emitSafeEvent, undefined, [logger, {}]);
    }).toThrow();
  });
});
