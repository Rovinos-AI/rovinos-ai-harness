// SPDX-License-Identifier: Apache-2.0
import { ROOT_CONTEXT, type Context, type SpanContext } from "@opentelemetry/api";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { Code, Id, type TelemetryConfig } from "@rovinos/schemas";
import type { LogRecordProcessor, ReadWriteLogRecord } from "@opentelemetry/sdk-logs";
import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { attr } from "../attr.js";
import { __resetLogRegistryForTests, defineLogRecord } from "../log-registry.js";
import { AllowlistLogRecordProcessor } from "./allowlist-log-processor.js";
import { ActiveRuns } from "../sentinel/active-runs.js";
import { SentinelGate, SentinelRequiredError } from "../sentinel/gate.js";
import { VaultRunView } from "../sentinel/run-values.js";
import { TripQueue } from "../sentinel/trips.js";

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
  correlation: { enabled: false },
};
const runId = Id.parse("A".repeat(26));

function makeTripQueue(): TripQueue {
  return new TripQueue({ emit: vi.fn(), enabled: () => true });
}

function makeEmptyGate(): SentinelGate {
  return new SentinelGate(
    new VaultRunView({
      version: () => Promise.resolve(0),
      listRawValueEntries: () => Promise.resolve([]),
    }),
    new ActiveRuns(),
    { tripQueue: makeTripQueue() },
  );
}

function defineTestLogRecord() {
  return defineLogRecord("harness.test.log_record", {
    "harness.test.code": attr.code(),
    "harness.test.count": attr.nonnegativeInt(),
    "harness.run.id": attr.optional(attr.id()),
    "harness.user.pseudonym": attr.optional(attr.pseudonym()),
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
    expect(sanitized?.instrumentationScope).toEqual({ name: "@rovinos/telemetry" });
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

  it("enforces the correlation opt-in before exporting a registered pseudonym", async () => {
    defineTestLogRecord();
    const input = makeSdkLogRecord({
      attributes: { "harness.user.pseudonym": `p_${"a".repeat(26)}` },
    });

    const omittedNext = createNextProcessor();
    const omitted = new AllowlistLogRecordProcessor(omittedNext, { gate: makeEmptyGate() });
    omitted.onEmit(input);
    await omitted.forceFlush();
    expect(omittedNext.onEmit.mock.calls[0]?.[0].attributes).toEqual({});

    const disabledNext = createNextProcessor();
    const disabled = new AllowlistLogRecordProcessor(disabledNext, {
      telemetry: disabledTelemetry,
    });
    disabled.onEmit(input);
    await disabled.forceFlush();
    expect(disabledNext.onEmit.mock.calls[0]?.[0].attributes).toEqual({});

    const enabledNext = createNextProcessor();
    const enabled = new AllowlistLogRecordProcessor(enabledNext, {
      telemetry: {
        ...disabledTelemetry,
        correlation: { enabled: true },
      },
    });
    enabled.onEmit(input);
    await enabled.forceFlush();
    expect(enabledNext.onEmit.mock.calls[0]?.[0].attributes).toEqual({
      "harness.user.pseudonym": `p_${"a".repeat(26)}`,
    });
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
        listRawValueEntries: () =>
          Promise.resolve([{ entityType: Code.parse("email"), rawValue: canary }]),
      }),
      activeRuns,
      { tripQueue: makeTripQueue() },
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

  it("forwards exactly one sentinel alert without sentinel scanning or re-enqueueing it", async () => {
    defineLogRecord("harness.sentinel.trip", {
      "harness.run.id": attr.optional(attr.id()),
      "harness.sentinel.trip.count": attr.nonnegativeInt(),
    });
    const next = createNextProcessor();
    const activeRuns = new ActiveRuns();
    activeRuns.register(runId);
    const canary = "harness.sentinel.trip";
    const processorRef: { current?: AllowlistLogRecordProcessor } = {};
    const queue = new TripQueue({
      emit: (record) => {
        processorRef.current?.onEmit(
          makeSdkLogRecord({
            body: record.body,
            attributes: record.attributes ?? {},
            ...(record.eventName === undefined ? {} : { eventName: record.eventName }),
          }),
          record.context,
        );
      },
      enabled: () => true,
    });
    const gate = new SentinelGate(
      new VaultRunView({
        version: () => Promise.resolve(1),
        listRawValueEntries: () =>
          Promise.resolve([{ entityType: Code.parse("email"), rawValue: canary }]),
      }),
      activeRuns,
      { tripQueue: queue },
    );
    const check = vi.spyOn(gate, "check");
    const processor = new AllowlistLogRecordProcessor(next, { gate });
    processorRef.current = processor;

    queue.enqueue({ runId, entities: [{ type: "email", count: 1 }] });
    await processor.forceFlush();

    expect(check).not.toHaveBeenCalled();
    expect(next.onEmit).toHaveBeenCalledOnce();
    expect(queue.size).toBe(1);
  });

  it("waits for in-flight gate checks before completing a telemetry flush", async () => {
    defineTestLogRecord();
    const next = createNextProcessor();
    const gate = new SentinelGate(
      new VaultRunView({
        version: () => Promise.resolve(0),
        listRawValueEntries: () => Promise.resolve([]),
      }),
      new ActiveRuns(),
      { tripQueue: makeTripQueue() },
    );
    let releaseCheck: (
      result:
        | { ok: true }
        | {
            ok: false;
            reason: "hit" | "error" | "timeout";
          },
    ) => void = () => undefined;
    const pendingCheck = new Promise<
      | {
          ok: true;
        }
      | {
          ok: false;
          reason: "hit" | "error" | "timeout";
        }
    >((resolve) => {
      releaseCheck = resolve;
    });
    vi.spyOn(gate, "check").mockReturnValue(pendingCheck);
    const processor = new AllowlistLogRecordProcessor(next, { gate });
    processor.onEmit(makeSdkLogRecord());

    let flushCompleted = false;
    const flushing = processor.forceFlush().then(() => {
      flushCompleted = true;
    });
    await Promise.resolve();

    expect(flushCompleted).toBe(false);
    releaseCheck({ ok: true });
    await flushing;
    expect(next.onEmit).toHaveBeenCalledOnce();
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
        listRawValueEntries: () => Promise.resolve([]),
      }),
      new ActiveRuns(),
      { tripQueue: makeTripQueue() },
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
