// SPDX-License-Identifier: Apache-2.0
import { ROOT_CONTEXT, SpanKind, SpanStatusCode, type Context } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { attr } from "../attr.js";
import { defineSpan, __resetRegistryForTests } from "../registry.js";
import { AllowlistSpanProcessor, sanitizeSpan } from "./allowlist-span-processor.js";

const metricMocks = vi.hoisted(() => ({
  record: vi.fn<(reason: string) => void>(),
}));

vi.mock("../metrics.js", () => ({
  countDroppedTelemetry: metricMocks.record,
}));

const context = {
  traceId: "11111111111111111111111111111111",
  spanId: "2222222222222222",
  traceFlags: 1,
};

function defineTestSpan() {
  return defineSpan("harness.test.operation", {
    "harness.request.id": attr.id(),
    "harness.test.count": attr.int(),
    "harness.test.mode": attr.enum(["fast", "safe"]),
  });
}

function makeReadableSpan(overrides: Partial<ReadableSpan> = {}): ReadableSpan {
  return {
    name: "harness.test.operation",
    kind: SpanKind.INTERNAL,
    spanContext: () => context,
    startTime: [1, 2],
    endTime: [3, 4],
    status: { code: SpanStatusCode.ERROR, message: "sensitive status message" },
    attributes: {
      "harness.request.id": "00000000000000000000000000",
      "harness.test.count": 3,
      "harness.test.mode": "fast",
    },
    links: [{ context, attributes: { "harness.link.secret": "must be removed" } }],
    events: [
      {
        name: "exception",
        time: [2, 3],
        attributes: { "exception.message": "must be removed" },
      },
    ],
    duration: [2, 2],
    ended: true,
    resource: resourceFromAttributes({
      "service.name": "harness",
      "host.name": "must be removed",
    }),
    instrumentationScope: { name: "harness-test" },
    droppedAttributesCount: 1,
    droppedEventsCount: 2,
    droppedLinksCount: 3,
    ...overrides,
  };
}

function createNextProcessor() {
  return {
    onStart: vi.fn<(span: Span, parentContext: Context) => void>(),
    onEnd: vi.fn<(span: ReadableSpan) => void>(),
    forceFlush: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    shutdown: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  } satisfies SpanProcessor;
}

describe("sanitizeSpan", () => {
  beforeEach(() => {
    __resetRegistryForTests();
    metricMocks.record.mockClear();
  });

  it("keeps registered valid attributes and rebuilds all readable span fields", () => {
    defineTestSpan();
    const input = makeReadableSpan();

    const sanitized: ReadableSpan | undefined = sanitizeSpan(input);

    expect(sanitized).toBeDefined();
    expect(sanitized).not.toBe(input);
    expect(sanitized?.attributes).toEqual({
      "harness.request.id": "00000000000000000000000000",
      "harness.test.count": 3,
      "harness.test.mode": "fast",
    });
    expect(sanitized?.name).toBe(input.name);
    expect(sanitized?.kind).toBe(input.kind);
    expect(sanitized?.spanContext()).toEqual(context);
    expect(sanitized?.startTime).toEqual([1, 2]);
    expect(sanitized?.endTime).toEqual([3, 4]);
    expect(sanitized?.duration).toEqual([2, 2]);
    expect(sanitized?.ended).toBe(true);
    expect(sanitized?.droppedAttributesCount).toBe(1);
    expect(sanitized?.droppedEventsCount).toBe(2);
    expect(sanitized?.droppedLinksCount).toBe(3);
    expect(sanitized?.parentSpanContext).toBeUndefined();
  });

  it("drops spans without a registered definition", () => {
    expect(sanitizeSpan(makeReadableSpan({ name: "http.request" }))).toBeUndefined();
    expect(metricMocks.record).toHaveBeenCalledWith("unregistered_span");
  });

  it("drops and counts extra attributes and values that fail their schema", () => {
    defineTestSpan();

    const sanitized = sanitizeSpan(
      makeReadableSpan({
        attributes: {
          "harness.request.id": "00000000000000000000000000",
          "harness.test.count": 1.5,
          "harness.test.mode": "unsafe",
          "harness.extra.attribute": "not registered",
        },
      }),
    );

    expect(sanitized?.attributes).toEqual({
      "harness.request.id": "00000000000000000000000000",
    });
    expect(metricMocks.record.mock.calls).toEqual([
      ["invalid_attr"],
      ["invalid_attr"],
      ["unregistered_attr"],
      ["event_stripped"],
    ]);
  });

  it("strips events, status messages, link attributes, and non-allowlisted resource attributes", () => {
    defineTestSpan();
    const input = makeReadableSpan({
      resource: resourceFromAttributes({
        "service.name": "harness",
        "service.version": "1.0.0",
        "harness.policy.version": "2",
        "telemetry.sdk.name": "opentelemetry",
        "telemetry.sdk.language": "nodejs",
        "telemetry.sdk.version": "2.12.0",
        "host.name": "must not escape",
      }),
    });

    const sanitized = sanitizeSpan(input);

    expect(sanitized?.events).toEqual([]);
    expect(sanitized?.status.code).toBe(SpanStatusCode.ERROR);
    expect(sanitized?.status.message).toBeUndefined();
    expect(sanitized?.links).toEqual([{ context }]);
    expect(sanitized?.resource.attributes).toEqual({
      "service.name": "harness",
      "service.version": "1.0.0",
      "harness.policy.version": "2",
      "telemetry.sdk.name": "opentelemetry",
      "telemetry.sdk.language": "nodejs",
      "telemetry.sdk.version": "2.12.0",
    });
    expect(metricMocks.record).toHaveBeenCalledWith("event_stripped");
  });

  it("does not retain mutable time tuples or the source resource", () => {
    defineTestSpan();
    const input = makeReadableSpan();

    const sanitized = sanitizeSpan(input);

    expect(sanitized?.startTime).not.toBe(input.startTime);
    expect(sanitized?.endTime).not.toBe(input.endTime);
    expect(sanitized?.duration).not.toBe(input.duration);
    expect(sanitized?.resource).not.toBe(input.resource);
  });

  it("drops malformed span data and counts processor errors", () => {
    defineTestSpan();
    const malformed = Object.defineProperty(makeReadableSpan(), "attributes", {
      get() {
        throw new Error("sensitive getter value");
      },
    });

    expect(sanitizeSpan(malformed)).toBeUndefined();
    expect(metricMocks.record).toHaveBeenCalledWith("processor_error");
  });
});

describe("AllowlistSpanProcessor", () => {
  beforeEach(() => {
    __resetRegistryForTests();
    metricMocks.record.mockClear();
  });

  it("delegates lifecycle methods and sends only sanitized spans downstream", async () => {
    const definition = defineTestSpan();
    const next = createNextProcessor();
    const processor = new AllowlistSpanProcessor(next);
    const input = makeReadableSpan();
    const startSpan = definition.start({
      "harness.request.id": "00000000000000000000000000",
      "harness.test.count": 1,
      "harness.test.mode": "fast",
    });
    const parentContext = ROOT_CONTEXT;

    const onStart = processor.onStart.bind(processor);
    Reflect.apply(onStart, processor, [startSpan, parentContext]);
    processor.onEnd(input);
    await processor.forceFlush();
    await processor.shutdown();

    expect(vi.mocked(next.onStart)).toHaveBeenCalledWith(startSpan, parentContext);
    expect(vi.mocked(next.onEnd)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(next.onEnd).mock.calls[0]?.[0].attributes).toEqual(input.attributes);
    expect(vi.mocked(next.forceFlush)).toHaveBeenCalledOnce();
    expect(vi.mocked(next.shutdown)).toHaveBeenCalledOnce();
  });

  it("drops unregistered and malformed spans without throwing into the SDK", () => {
    const next = createNextProcessor();
    const processor = new AllowlistSpanProcessor(next);
    defineTestSpan();
    const malformed = Object.defineProperty(makeReadableSpan(), "name", {
      get() {
        throw new Error("malformed span");
      },
    });

    expect(() => {
      processor.onEnd(makeReadableSpan({ name: "http.request" }));
    }).not.toThrow();
    expect(() => {
      processor.onEnd(malformed);
    }).not.toThrow();
    expect(next.onEnd).not.toHaveBeenCalled();
    expect(metricMocks.record.mock.calls).toEqual([["unregistered_span"], ["processor_error"]]);
  });

  it("contains downstream processor failures and counts them", () => {
    defineTestSpan();
    const next = createNextProcessor();
    vi.mocked(next.onEnd).mockImplementation(() => {
      throw new Error("downstream failure");
    });
    const processor = new AllowlistSpanProcessor(next);

    expect(() => {
      processor.onEnd(makeReadableSpan());
    }).not.toThrow();
    expect(metricMocks.record).toHaveBeenCalledWith("processor_error");
  });

  it("contains downstream start callback failures", () => {
    const next = createNextProcessor();
    vi.mocked(next.onStart).mockImplementation(() => {
      throw new Error("downstream start failure");
    });
    const processor = new AllowlistSpanProcessor(next);
    const startSpan = defineTestSpan().start({
      "harness.request.id": "00000000000000000000000000",
      "harness.test.count": 1,
      "harness.test.mode": "fast",
    });

    expect(() => {
      const onStart = processor.onStart.bind(processor);
      Reflect.apply(onStart, processor, [startSpan, ROOT_CONTEXT]);
    }).not.toThrow();
    expect(metricMocks.record).toHaveBeenCalledWith("processor_error");
  });
});
