// SPDX-License-Identifier: Apache-2.0
import { ROOT_CONTEXT, SpanKind, SpanStatusCode, trace, type Context } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
  type Span,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
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

function withMalformedField(field: string, value: unknown): ReadableSpan {
  const span = makeReadableSpan();
  Object.defineProperty(span, field, { value });
  return span;
}

function withMalformedAttribute(value: unknown): ReadableSpan {
  const span = makeReadableSpan();
  Object.defineProperty(span, "attributes", {
    value: {
      "harness.request.id": "00000000000000000000000000",
      "harness.test.count": value,
      "harness.test.mode": "fast",
    },
  });
  return span;
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

  it("drops invalid values from allowlisted resource attributes", () => {
    defineTestSpan();
    const resource = resourceFromAttributes({ "service.version": "1.0.0" });
    Object.defineProperty(resource, "attributes", {
      value: { ...resource.attributes, "service.name": ["not a scalar"] },
    });

    const sanitized = sanitizeSpan(makeReadableSpan({ resource }));

    expect(sanitized?.resource.attributes).toEqual({ "service.version": "1.0.0" });
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

  it("has the public sanitized-span return type", () => {
    expectTypeOf(sanitizeSpan).returns.toEqualTypeOf<ReadableSpan | undefined>();
    expect(sanitizeSpan).toBeTypeOf("function");
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

  it.each([
    { name: "null attributes", span: withMalformedField("attributes", null) },
    { name: "non-function spanContext", span: withMalformedField("spanContext", null) },
    {
      name: "invalid spanContext result",
      span: withMalformedField("spanContext", () => ({
        traceId: "bad",
        spanId: "bad",
        traceFlags: 0,
      })),
    },
    { name: "invalid parent context", span: withMalformedField("parentSpanContext", {}) },
    { name: "invalid kind", span: withMalformedField("kind", "internal") },
    { name: "missing status", span: withMalformedField("status", undefined) },
    { name: "invalid status code", span: withMalformedField("status", { code: "ERROR" }) },
    { name: "non-array links", span: withMalformedField("links", {}) },
    { name: "invalid link context", span: withMalformedField("links", [{ context: {} }]) },
    { name: "non-array events", span: withMalformedField("events", null) },
    { name: "missing resource", span: withMalformedField("resource", undefined) },
    { name: "short start time", span: withMalformedField("startTime", [1]) },
    { name: "invalid end time", span: withMalformedField("endTime", "invalid") },
    { name: "missing duration", span: withMalformedField("duration", undefined) },
    { name: "invalid ended flag", span: withMalformedField("ended", "true") },
    {
      name: "missing instrumentation scope",
      span: withMalformedField("instrumentationScope", undefined),
    },
    { name: "invalid dropped count", span: withMalformedField("droppedLinksCount", -1) },
    {
      name: "throwing attribute ownKeys proxy",
      span: withMalformedField(
        "attributes",
        new Proxy(
          {},
          {
            ownKeys() {
              throw new Error("untrusted proxy");
            },
          },
        ),
      ),
    },
    ...(
      [
        { name: "array", value: ["unsafe"] },
        { name: "object", value: { unsafe: true } },
        { name: "NaN", value: Number.NaN },
        { name: "Infinity", value: Number.POSITIVE_INFINITY },
        { name: "bigint", value: 1n },
      ] satisfies { name: string; value: unknown }[]
    ).map(({ name, value }) => ({
      name: `invalid ${name} attribute value`,
      span: withMalformedAttribute(value),
    })),
  ])("does not throw or forward malformed input: $name", ({ span }) => {
    defineTestSpan();
    const next = createNextProcessor();
    const processor = new AllowlistSpanProcessor(next);

    expect(() => {
      processor.onEnd(span);
    }).not.toThrow();

    const forwarded = vi.mocked(next.onEnd).mock.calls.map(([value]) => value);
    expect(forwarded.length).toBeLessThanOrEqual(1);
    for (const output of forwarded) {
      expect(
        Object.keys(output.attributes).every((key) =>
          ["harness.request.id", "harness.test.count", "harness.test.mode"].includes(key),
        ),
      ).toBe(true);
      expect(
        Object.values(output.attributes).every(
          (value) =>
            typeof value === "string" ||
            typeof value === "boolean" ||
            (typeof value === "number" && Number.isFinite(value)),
        ),
      ).toBe(true);
      expect(output.events).toEqual([]);
      expect(output.status.message).toBeUndefined();
      expect(
        output.links.every((link) => Object.keys(link).every((key) => key === "context")),
      ).toBe(true);
      expect(
        Object.values(output.resource.attributes).every(
          (value) =>
            typeof value === "string" ||
            typeof value === "boolean" ||
            (typeof value === "number" && Number.isFinite(value)),
        ),
      ).toBe(true);
      expect(output.startTime).toHaveLength(2);
      expect(output.endTime).toHaveLength(2);
      expect(output.duration).toHaveLength(2);
    }
  });

  it("sends only sanitized spans through the real SDK exporter pipeline", async () => {
    const exporter = new InMemorySpanExporter();
    const allowlist = new AllowlistSpanProcessor(new SimpleSpanProcessor(exporter));
    const provider = new BasicTracerProvider({ spanProcessors: [allowlist] });
    trace.setGlobalTracerProvider(provider);
    const definition = defineTestSpan();

    try {
      const span = definition.start({
        "harness.request.id": "00000000000000000000000000",
        "harness.test.count": 3,
        "harness.test.mode": "fast",
      });
      span.setAttribute("harness.unregistered.attribute", "must not be exported");
      span.addEvent("exception", { "exception.message": "must not be exported" });
      span.setStatus({ code: SpanStatusCode.ERROR, message: "must not be exported" });
      span.end();

      const [exported] = exporter.getFinishedSpans();
      expect(exported?.attributes).toEqual({
        "harness.request.id": "00000000000000000000000000",
        "harness.test.count": 3,
        "harness.test.mode": "fast",
      });
      expect(exported?.events).toEqual([]);
      expect(exported?.status).toEqual({ code: SpanStatusCode.ERROR });
    } finally {
      await provider.shutdown();
    }
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
