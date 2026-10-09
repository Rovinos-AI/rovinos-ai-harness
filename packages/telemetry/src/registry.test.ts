// SPDX-License-Identifier: Apache-2.0
import { ROOT_CONTEXT, SpanStatusCode, trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { z } from "zod";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "node:process";
import {
  __resetRegistryForTests,
  attr,
  defineSpan,
  getAttrMeta,
  HarnessError,
  isSafeAttr,
  listSpanDefinitions,
  lookupSpanDefinition,
  SpanRegistryError,
  withSpan,
  type SpanDefinition,
  type SpanDefinitionShape,
  type SpanShape,
} from "./index.js";
import { getTracer } from "./tracer.js";

const exporter = new InMemorySpanExporter();
const testId = "00000000000000000000000000";
const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});

beforeAll(() => {
  trace.setGlobalTracerProvider(provider);
});

afterAll(async () => {
  await provider.shutdown();
});

beforeEach(() => {
  exporter.reset();
  __resetRegistryForTests();
});

function defineTestSpan() {
  return defineSpan("harness.test.operation", {
    requestId: attr.id(),
    count: attr.int(),
    mode: attr.enum(["fast", "safe"]),
  });
}

function invokeStart<Shape extends SpanDefinitionShape, Schema extends z.ZodType>(
  definition: SpanDefinition<Shape, Schema>,
  attrs: unknown,
): unknown {
  return Reflect.apply(definition.start.bind(definition), undefined, [attrs]);
}

function captureError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

function requireRegistryError(error: unknown): SpanRegistryError {
  if (!(error instanceof SpanRegistryError)) {
    throw new Error("Expected a span registry error.");
  }
  return error;
}

describe("attribute schemas", () => {
  it("registers metadata for every safe helper and preserves it through optional", () => {
    const schemas: { readonly schema: z.ZodType; readonly kind: string }[] = [
      { schema: attr.id(), kind: "id" },
      { schema: attr.code(), kind: "code" },
      { schema: attr.hash(), kind: "hash" },
      { schema: attr.enum(["one", "two"]), kind: "enum" },
      { schema: attr.int(), kind: "int" },
      { schema: attr.num(), kind: "num" },
      { schema: attr.bool(), kind: "bool" },
    ];

    for (const { schema, kind } of schemas) {
      expect(isSafeAttr(schema)).toBe(true);
      expect(getAttrMeta(schema)?.kind).toBe(kind);
    }

    expect(getAttrMeta(attr.optional(attr.code()))).toEqual({
      kind: "code",
      optional: true,
    });
    expect(isSafeAttr(z.string())).toBe(false);
    expect(isSafeAttr(attr.optional(z.string()))).toBe(false);
    expect(getAttrMeta(z.string())).toBeUndefined();
  });

  it("validates the documented attribute value kinds", () => {
    expect(attr.id().safeParse(testId).success).toBe(true);
    expect(attr.code().safeParse("tool_failed").success).toBe(true);
    expect(attr.hash().safeParse("a".repeat(64)).success).toBe(true);
    expect(attr.enum(["one", "two"]).safeParse("one").success).toBe(true);
    expect(attr.enum(["one", "two"]).safeParse("three").success).toBe(false);
    expect(attr.int().safeParse(2).success).toBe(true);
    expect(attr.int().safeParse(2.5).success).toBe(false);
    expect(attr.num().safeParse(Number.POSITIVE_INFINITY).success).toBe(false);
    expect(attr.bool().safeParse(false).success).toBe(true);
  });
});

describe("span registry", () => {
  it("registers safe attribute schemas and adds an optional error code", () => {
    const definition = defineTestSpan();

    expect(definition.name).toBe("harness.test.operation");
    expect(Object.isFrozen(definition)).toBe(true);
    expect(Object.isFrozen(definition.shape)).toBe(true);
    expect(
      definition.schema.parse({
        requestId: testId,
        count: 1,
        mode: "fast",
      }),
    ).toEqual({
      requestId: testId,
      count: 1,
      mode: "fast",
    });
    expect(getAttrMeta(definition.shape["harness.error.code"])).toEqual({
      kind: "code",
      optional: true,
    });
  });

  it("rejects an unconstrained attribute, including an optional wrapper", () => {
    expect(() => defineSpan("harness.test.unsafe", { text: z.string() })).toThrowError(
      "span_attr_unconstrained",
    );
    expect(() =>
      defineSpan("harness.test.optional_unsafe", { text: attr.optional(z.string()) }),
    ).toThrowError("span_attr_unconstrained");
  });

  it("validates one snapshot of accessor-based attribute shapes", () => {
    let reads = 0;
    const changingShape: SpanShape = {};
    Object.defineProperty(changingShape, "requestId", {
      enumerable: true,
      get() {
        reads += 1;
        return reads === 1 ? attr.id() : z.string();
      },
    });

    const definition = defineSpan("harness.test.getter", changingShape);

    expect(reads).toBe(1);
    expect(definition.schema.safeParse({ requestId: testId }).success).toBe(true);
    expect(definition.schema.safeParse({ requestId: "unbounded" }).success).toBe(false);
  });

  it("rejects invalid, reserved, and duplicate names or attributes", () => {
    for (const name of ["mcp.call", "Harness.test", "harness.", "harness." + "a".repeat(60)]) {
      expect(() => defineSpan(name, {})).toThrowError("span_name_invalid");
    }

    expect(() =>
      defineSpan("harness.test.reserved", { "harness.error.code": attr.code() }),
    ).toThrowError("span_attr_reserved");

    defineTestSpan();
    expect(() => defineTestSpan()).toThrowError("span_duplicate");
  });

  it("rejects extra keys and invalid values before creating a span", () => {
    const definition = defineTestSpan();
    const attrs = {
      requestId: testId,
      count: 1,
      mode: "fast",
    };

    expect(() => invokeStart(definition, { ...attrs, private: "not-allowed" })).toThrowError(
      "span_attr_invalid",
    );
    const invalidValueError = requireRegistryError(
      captureError(() => invokeStart(definition, { ...attrs, count: 1.5 })),
    );
    expect(invalidValueError.code).toBe("span_attr_invalid");
    expect(invalidValueError.issues.map(({ path }) => path)).toEqual([["count"]]);
    expect(JSON.stringify(invalidValueError.issues)).not.toContain("1.5");
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it("passes parent context and links to the tracer", () => {
    const definition = defineTestSpan();
    const span = definition.start(
      { requestId: testId, count: 1, mode: "fast" },
      {
        parent: ROOT_CONTEXT,
        links: [
          {
            context: {
              traceId: "11111111111111111111111111111111",
              spanId: "2222222222222222",
              traceFlags: 1,
            },
          },
        ],
      },
    );

    span.end();
    expect(exporter.getFinishedSpans()[0]?.links).toHaveLength(1);
  });

  it("converts attribute getter failures to value-free validation errors", () => {
    const definition = defineTestSpan();
    const attrs = new Proxy(
      { requestId: testId, count: 1, mode: "fast" },
      {
        get(target, key) {
          if (key === "count") {
            throw new Error("sensitive getter value");
          }
          if (key === "requestId") {
            return target.requestId;
          }
          if (key === "mode") {
            return target.mode;
          }
          return undefined;
        },
      },
    );

    expect(() => invokeStart(definition, attrs)).toThrowError("span_attr_invalid");
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it("returns definitions in registration order and looks them up by name", () => {
    const first = defineTestSpan();
    const second = defineSpan("harness.test.second", { enabled: attr.bool() });

    expect(listSpanDefinitions()).toEqual([first, second]);
    expect(lookupSpanDefinition(first.name)).toBe(first);
    expect(lookupSpanDefinition("harness.test.missing")).toBeUndefined();
  });

  it("ends spans after success and on errors without recording messages", async () => {
    const definition = defineTestSpan();
    const attrs: Parameters<typeof definition.start>[0] = {
      requestId: testId,
      count: 1,
      mode: "safe",
    };
    const harnessError = new HarnessError("tool_failed", "sensitive error message");
    const forgedHarnessError = new Error("forged sensitive message");
    Object.setPrototypeOf(forgedHarnessError, HarnessError.prototype);
    expect(Reflect.set(harnessError, "code", "sensitive error message")).toBe(false);

    await expect(withSpan(definition, attrs, () => "done")).resolves.toBe("done");
    await expect(
      withSpan(definition, attrs, () => {
        throw harnessError;
      }),
    ).rejects.toThrow("sensitive error message");
    await expect(
      withSpan(definition, attrs, () => {
        throw new Error("untyped sensitive message");
      }),
    ).rejects.toThrow("untyped sensitive message");
    await expect(
      withSpan(definition, attrs, () => {
        throw forgedHarnessError;
      }),
    ).rejects.toBe(forgedHarnessError);

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(4);
    expect(spans[0]?.ended).toBe(true);
    expect(spans[1]?.status.code).toBe(SpanStatusCode.ERROR);
    expect(spans[1]?.status.message).toBeUndefined();
    expect(spans[1]?.attributes["harness.error.code"]).toBe("tool_failed");
    expect(spans[2]?.status.code).toBe(SpanStatusCode.ERROR);
    expect(spans[2]?.attributes["harness.error.code"]).toBeUndefined();
    expect(spans[3]?.status.code).toBe(SpanStatusCode.ERROR);
    expect(spans[3]?.attributes["harness.error.code"]).toBeUndefined();
    const exportedFields = JSON.stringify(
      spans.map(({ attributes, events, status }) => ({ attributes, events, status })),
    );
    expect(exportedFields).not.toContain("sensitive error message");
    expect(exportedFields).not.toContain("untyped sensitive message");
    expect(exportedFields).not.toContain("forged sensitive message");
  });

  it("exposes the registered tracer used by span starts", () => {
    expect(getTracer()).toBe(provider.getTracer("@harness/telemetry"));
  });

  it("protects the test-only registry reset", () => {
    defineTestSpan();
    const initialNodeEnv = env.NODE_ENV;
    env.NODE_ENV = "production";
    expect(() => {
      __resetRegistryForTests();
    }).toThrowError("span_registry_reset_forbidden");
    if (initialNodeEnv === undefined) {
      delete env.NODE_ENV;
    } else {
      env.NODE_ENV = initialNodeEnv;
    }
    expect(listSpanDefinitions()).toHaveLength(1);
  });

  it("validates error codes before creating a harness error", () => {
    expect(() => new HarnessError("INVALID CODE")).toThrowError("Harness error code is invalid.");
    const registryError = new SpanRegistryError("span_duplicate");
    expect(registryError.issues).toEqual([]);
    expect(Reflect.set(registryError, "code", "tool_failed")).toBe(false);
  });
});
