// SPDX-License-Identifier: Apache-2.0
import { ROOT_CONTEXT, type Context, type SpanContext } from "@opentelemetry/api";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { Id, type TelemetryConfig } from "@harness/schemas";
import type { LogRecordProcessor, ReadWriteLogRecord } from "@opentelemetry/sdk-logs";
import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { attr } from "../attr.js";
import { __resetLogRegistryForTests, defineLogRecord } from "../log-registry.js";
import { AllowlistLogRecordProcessor } from "./allowlist-log-processor.js";
import { ActiveRuns } from "../sentinel/active-runs.js";
import { SentinelGate, SentinelRequiredError } from "../sentinel/gate.js";
import { VaultRunView } from "../sentinel/run-values.js";

const metricMocks = vi.hoisted(() => ({
  record: vi.fn<(reason: string) => void>(),
}));

vi.mock("../metrics.js", () => ({
  countDroppedTelemetry: metricMocks.record,
}));

const spanContext: SpanContext = {
  traceId: "11111111111111111111111111111111",
  spanId: "2222222222222222",
  traceFlags: 1,
};
const disabledTelemetry: TelemetryConfig = {
  sentinel: { minValueLength: 6, enabled: false },
};
const runId = Id.parse("A".repeat(26));

function defineTestLogRecord() {
  return defineLogRecord("harness.test.log_record", {
    "harness.test.code": attr.code(),
    "harness.test.count": attr.nonnegativeInt(),
    "harness.run.id": attr.optional(attr.id()),
  });
}

function makeSdkLogRecord(overrides: Partial<ReadWriteLogRecord> = {}): ReadWriteLogRecord {
  const record: ReadWriteLogRecord = {
    hrTime: [1, 2],
    hrTimeObserved: [3, 4],
    spanContext,
    resource: resourceFromAttributes({
      "service.name": "harness",
      "host.name": "private-host",
    }),
    instrumentationScope: { name: "private-instrumentation" },
    attributes: {
      "harness.test.code": "safe_code",
      "harness.test.count": 2,
    },
    severityNumber: SeverityNumber.INFO,
    severityText: "private severity",
    body: "sensitive free-form body",
    eventName: "harness.test.log_record",
    droppedAttributesCount: 0,
    setAttribute: () => record,
    setAttributes: () => record,
    setBody: () => record,
    setEventName: () => record,
    setSeverityNumber: () => record,
    setSeverityText: () => record,
    ...overrides,
  };
  return record;
}

function createNextProcessor() {
  return {
    onEmit: vi.fn<(record: ReadWriteLogRecord, context?: Context) => void>(),
    forceFlush: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    shutdown: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  } satisfies LogRecordProcessor;
}

describe("AllowlistLogRecordProcessor", () => {
  beforeEach(() => {
    __resetLogRegistryForTests();
    metricMocks.record.mockClear();
  });

  it("forwards a fresh record with a registered body and only valid allowlisted attributes", async () => {
    const definition = defineTestLogRecord();
    const next = createNextProcessor();
    const processor = new AllowlistLogRecordProcessor(next, { telemetry: disabledTelemetry });
    const input = makeSdkLogRecord({
      attributes: {
        "harness.test.code": "safe_code",
        "harness.test.count": -1,
        "harness.extra": "not registered",
      },
      resource: resourceFromAttributes({
        "service.name": "harness",
        "host.name": "private-host",
      }),
    });

    processor.onEmit(input, ROOT_CONTEXT);
    await processor.forceFlush();

    const sanitized = vi.mocked(next.onEmit).mock.calls[0]?.[0];
    expect(sanitized).toBeDefined();
    expect(sanitized).not.toBe(input);
    expect(sanitized?.body).toBe(definition.name);
    expect(sanitized?.eventName).toBe(definition.name);
    expect(sanitized?.attributes).toEqual({ "harness.test.code": "safe_code" });
    expect(sanitized?.severityText).toBeUndefined();
    expect(sanitized?.spanContext).toEqual(spanContext);
    expect(sanitized?.resource.attributes).toEqual({ "service.name": "harness" });
    expect(sanitized?.instrumentationScope).toEqual({ name: "@harness/telemetry" });
    expect(sanitized?.hrTime).not.toBe(input.hrTime);
    expect(input.body).toBe("sensitive free-form body");
    expect(metricMocks.record.mock.calls).toEqual([["invalid_attr"], ["unregistered_attr"]]);
    sanitized?.setBody("attempted overwrite");
    expect(sanitized?.body).toBe(definition.name);
  });

  it("drops unregistered records and records without a registered event name", async () => {
    const definition = defineTestLogRecord();
    const next = createNextProcessor();
    const processor = new AllowlistLogRecordProcessor(next, { telemetry: disabledTelemetry });

    processor.onEmit(makeSdkLogRecord({ eventName: "harness.test.missing" }));
    processor.onEmit(makeSdkLogRecord({ eventName: "", body: definition.name }));
    await processor.forceFlush();

    expect(next.onEmit).not.toHaveBeenCalled();
    expect(metricMocks.record.mock.calls).toEqual([
      ["unregistered_log_record"],
      ["unregistered_log_record"],
    ]);
  });

  it("preserves allowlisted resource attributes and drops all others", async () => {
    defineTestLogRecord();
    const next = createNextProcessor();
    const processor = new AllowlistLogRecordProcessor(next, { telemetry: disabledTelemetry });

    processor.onEmit(
      makeSdkLogRecord({
        resource: resourceFromAttributes({
          "service.name": "harness",
          "service.version": "1.0.0",
          "harness.policy.version": "2",
          "telemetry.sdk.name": "opentelemetry",
          "telemetry.sdk.language": "nodejs",
          "telemetry.sdk.version": "2.12.0",
          "host.name": "private-host",
        }),
      }),
    );
    await processor.forceFlush();

    expect(next.onEmit.mock.calls[0]?.[0].resource.attributes).toEqual({
      "service.name": "harness",
      "service.version": "1.0.0",
      "harness.policy.version": "2",
      "telemetry.sdk.name": "opentelemetry",
      "telemetry.sdk.language": "nodejs",
      "telemetry.sdk.version": "2.12.0",
    });
  });

  it("drops malformed records and contains downstream processor errors", async () => {
    defineTestLogRecord();
    const next = createNextProcessor();
    const processor = new AllowlistLogRecordProcessor(next, { telemetry: disabledTelemetry });
    const malformed = Object.defineProperty(makeSdkLogRecord(), "attributes", {
      get() {
        throw new Error("sensitive attributes");
      },
    });

    expect(() => {
      processor.onEmit(malformed);
    }).not.toThrow();
    await processor.forceFlush();
    vi.mocked(next.onEmit).mockImplementation(() => {
      throw new Error("downstream failure");
    });
    expect(() => {
      processor.onEmit(makeSdkLogRecord());
    }).not.toThrow();
    await processor.forceFlush();
    expect(metricMocks.record.mock.calls).toEqual([["processor_error"], ["processor_error"]]);
  });

  it("delegates lifecycle methods and exposes the OpenTelemetry interface", async () => {
    const next = createNextProcessor();
    const processor = new AllowlistLogRecordProcessor(next, { telemetry: disabledTelemetry });

    await processor.forceFlush();
    await processor.shutdown();

    expect(next.forceFlush).toHaveBeenCalledOnce();
    expect(next.shutdown).toHaveBeenCalledOnce();
    expectTypeOf(processor).toExtend<LogRecordProcessor>();
  });

  it("drops a log whose sanitized resource values contain a known raw value", async () => {
    defineTestLogRecord();
    const next = createNextProcessor();
    const canary = "private-service-name";
    const activeRuns = new ActiveRuns();
    activeRuns.register(runId);
    const gate = new SentinelGate(
      new VaultRunView({
        version: () => Promise.resolve(1),
        listRawValues: () => Promise.resolve([canary]),
      }),
      activeRuns,
    );
    const processor = new AllowlistLogRecordProcessor(next, { gate });

    processor.onEmit(
      makeSdkLogRecord({
        resource: resourceFromAttributes({ "service.name": canary }),
        attributes: {
          "harness.test.code": "safe_code",
          "harness.test.count": 2,
          "harness.run.id": runId,
        },
      }),
      ROOT_CONTEXT,
    );
    await processor.forceFlush();

    expect(next.onEmit).not.toHaveBeenCalled();
    expect(metricMocks.record).toHaveBeenCalledWith("leak_sentinel");
  });

  it("serializes log attributes in locale-independent ordinal order", async () => {
    defineLogRecord("harness.test.canonical_order", {
      "harness.test.a_": attr.enum(["first"]),
      "harness.test.aa": attr.enum(["second"]),
    });
    const next = createNextProcessor();
    const gate = new SentinelGate(
      new VaultRunView({
        version: () => Promise.resolve(0),
        listRawValues: () => Promise.resolve([]),
      }),
      new ActiveRuns(),
    );
    const check = vi.spyOn(gate, "check");
    const processor = new AllowlistLogRecordProcessor(next, { gate });

    processor.onEmit(
      makeSdkLogRecord({
        eventName: "harness.test.canonical_order",
        attributes: { "harness.test.aa": "second", "harness.test.a_": "first" },
      }),
    );
    await processor.forceFlush();

    const captured = check.mock.calls[0]?.[0];
    if (captured === undefined) {
      throw new Error("Expected the gate to inspect the log record.");
    }
    expect(captured.text.indexOf("harness.test.a_")).toBeLessThan(
      captured.text.indexOf("harness.test.aa"),
    );
  });

  it("requires a sentinel gate outside the explicit development opt-out", () => {
    const next = createNextProcessor();

    expect(() => new AllowlistLogRecordProcessor(next)).toThrow(SentinelRequiredError);
    expect(
      () =>
        new AllowlistLogRecordProcessor(next, {
          telemetry: disabledTelemetry,
          nodeEnv: "production",
        }),
    ).toThrow(SentinelRequiredError);
  });
});
