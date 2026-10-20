// SPDX-License-Identifier: Apache-2.0
import { context, ROOT_CONTEXT, SpanStatusCode, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { HarnessError } from "@harness/schemas";
import { z } from "zod";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "node:process";
import { defineSemconvSpan } from "./registry.js";
import {
  __resetRegistryForTests,
  attr,
  defineSpan,
  getAttrMeta,
  isSafeAttr,
  listSpanDefinitions,
  lookupSpanDefinition,
  setActiveSpanAttribute,
  SpanRegistryError,
  withSpan,
  type SpanDefinition,
  type SpanDefinitionShape,
  type SpanShape,
} from "./index.js";
import { getTracer } from "./tracer.js";

const exporter = new InMemorySpanExporter();
const testId = "00000000000000000000000000";
const testOwnerTask = { taskId: "4.7", packageName: "@harness/telemetry" } as const;
const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});

beforeAll(() => {
  trace.setGlobalTracerProvider(provider);
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
});

afterAll(async () => {
  await provider.shutdown();
  context.disable();
});

beforeEach(() => {
  exporter.reset();
  __resetRegistryForTests();
});

function defineTestSpan() {
  return defineSpan(
    "harness.test.operation",
    {
      "harness.request.id": attr.id(),
      "harness.test.count": attr.int(),
      "harness.test.mode": attr.enum(["fast", "safe"]),
    },
    testOwnerTask,
  );
}

class X extends HarnessError {
  readonly code = "x_failed";

  constructor() {
    super("sensitive error message");
  }
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
      { schema: attr.traceId(), kind: "id" },
      { schema: attr.spanId(), kind: "id" },
      { schema: attr.code(), kind: "code" },
      { schema: attr.hash(), kind: "hash" },
      { schema: attr.pseudonym(), kind: "pseudonym" },
      { schema: attr.enum(["one", "two"]), kind: "enum" },
      { schema: attr.int(), kind: "int" },
      { schema: attr.nonnegativeInt(), kind: "int" },
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
    expect(getAttrMeta("not-a-schema")).toBeUndefined();
  });

  it("validates the documented attribute value kinds", () => {
    expect(attr.id().safeParse(testId).success).toBe(true);
    expect(attr.traceId().safeParse("a".repeat(32)).success).toBe(true);
    expect(attr.traceId().safeParse("g".repeat(32)).success).toBe(false);
    expect(attr.spanId().safeParse("b".repeat(16)).success).toBe(true);
    expect(attr.spanId().safeParse("b".repeat(15)).success).toBe(false);
    expect(attr.code().safeParse("tool_failed").success).toBe(true);
    expect(attr.hash().safeParse("a".repeat(64)).success).toBe(true);
    expect(attr.pseudonym().safeParse(`p_${"a".repeat(26)}`).success).toBe(true);
    expect(attr.pseudonym().safeParse("alice@example.test").success).toBe(false);
    expect(attr.enum(["one", "two"]).safeParse("one").success).toBe(true);
    expect(attr.enum(["one", "two"]).safeParse("three").success).toBe(false);
    expect(attr.int().safeParse(2).success).toBe(true);
    expect(attr.int().safeParse(2.5).success).toBe(false);
    expect(attr.nonnegativeInt().safeParse(-1).success).toBe(false);
    expect(attr.num().safeParse(Number.POSITIVE_INFINITY).success).toBe(false);
    expect(attr.bool().safeParse(false).success).toBe(true);
  });
});

describe("span registry", () => {
  it("registers safe attribute schemas and adds an optional error code", () => {
    const definition = defineTestSpan();

    expect(definition.name).toBe("harness.test.operation");
    expect(Object.isFrozen(definition)).toBe(true);
    expect(definition.ownerTask).toEqual(testOwnerTask);
    expect(Object.isFrozen(definition.shape)).toBe(true);
    expect(
      definition.schema.parse({
        "harness.request.id": testId,
        "harness.test.count": 1,
        "harness.test.mode": "fast",
      }),
    ).toEqual({
      "harness.request.id": testId,
      "harness.test.count": 1,
      "harness.test.mode": "fast",
    });
    expect(getAttrMeta(definition.shape["harness.error.code"])).toEqual({
      kind: "code",
      optional: true,
    });
  });

  it("registers only allowlisted semantic-convention span names and attributes", () => {
    expect(() =>
      defineSpan(
        "harness.test.unowned",
        {},
        { taskId: "not-a-task", packageName: "@harness/telemetry" },
      ),
    ).toThrow("span_owner_task_invalid");
    expect(() => {
      Reflect.apply(defineSemconvSpan, undefined, ["mcp.server.call", {}, testOwnerTask]);
    }).toThrow("span_name_invalid");
    expect(() => {
      Reflect.apply(defineSemconvSpan, undefined, [
        "mcp.client.call",
        { "mcp.server.name": attr.code() },
        testOwnerTask,
      ]);
    }).toThrow("span_attr_name_invalid");

    const definition = defineSemconvSpan(
      "mcp.client.call",
      { "mcp.method.name": attr.enum(["tools/call"]) },
      testOwnerTask,
    );
    expect(definition.name).toBe("mcp.client.call");
    expect(definition.ownerTask).toEqual(testOwnerTask);
  });

  it("rejects an unconstrained attribute, including an optional wrapper", () => {
    expect(() =>
      defineSpan("harness.test.unsafe", { "harness.test.text": z.string() }, testOwnerTask),
    ).toThrow("span_attr_unconstrained");
    expect(() =>
      defineSpan(
        "harness.test.optional_unsafe",
        {
          "harness.test.text": attr.optional(z.string()),
        },
        testOwnerTask,
      ),
    ).toThrow("span_attr_unconstrained");
  });

  it("validates one snapshot of accessor-based attribute shapes", () => {
    let reads = 0;
    const changingShape: SpanShape = {};
    Object.defineProperty(changingShape, "harness.request.id", {
      enumerable: true,
      get() {
        reads += 1;
        return reads === 1 ? attr.id() : z.string();
      },
    });

    const definition = defineSpan("harness.test.getter", changingShape, testOwnerTask);

    expect(reads).toBe(1);
    expect(definition.schema.safeParse({ "harness.request.id": testId }).success).toBe(true);
    expect(definition.schema.safeParse({ "harness.request.id": "unbounded" }).success).toBe(false);
  });

  it("rejects invalid, reserved, and duplicate names or attributes", () => {
    for (const name of ["mcp.call", "Harness.test", "harness.", "harness." + "a".repeat(57)]) {
      expect(() => defineSpan(name, {}, testOwnerTask)).toThrow("span_name_invalid");
    }

    const maxLengthName = `harness.${"a".repeat(56)}`;
    expect(defineSpan(maxLengthName, {}, testOwnerTask).name).toBe(maxLengthName);
    expect(() =>
      defineSpan("harness.test.invalid_attribute", { private: attr.id() }, testOwnerTask),
    ).toThrow("span_attr_name_invalid");

    expect(() =>
      defineSpan("harness.test.reserved", { "harness.error.code": attr.code() }, testOwnerTask),
    ).toThrow("span_attr_reserved");

    defineTestSpan();
    expect(() => defineTestSpan()).toThrow("span_duplicate");
  });

  it("rejects extra keys and invalid values before creating a span", () => {
    const definition = defineTestSpan();
    const attrs = {
      "harness.request.id": testId,
      "harness.test.count": 1,
      "harness.test.mode": "fast",
    };

    expect(() => invokeStart(definition, { ...attrs, private: "not-allowed" })).toThrow(
      "span_attr_invalid",
    );
    const invalidValueError = requireRegistryError(
      captureError(() => invokeStart(definition, { ...attrs, "harness.test.count": 1.5 })),
    );
    expect(invalidValueError.code).toBe("span_attr_invalid");
    expect(invalidValueError.issues.map(({ path }) => path)).toEqual([["harness.test.count"]]);
    expect(JSON.stringify(invalidValueError.issues)).not.toContain("1.5");
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it("passes parent context and links to the tracer", () => {
    const definition = defineTestSpan();
    const span = definition.start(
      {
        "harness.request.id": testId,
        "harness.test.count": 1,
        "harness.test.mode": "fast",
      },
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

  it("sets only schema-validated attributes on the active span", () => {
    const definition = defineSpan(
      "harness.test.active",
      {
        "harness.test.attempts": attr.optional(attr.int()),
      },
      testOwnerTask,
    );
    const span = definition.start({});
    const activeContext = trace.setSpan(context.active(), span);

    context.with(activeContext, () => {
      setActiveSpanAttribute("harness.test.attempts", 2);
      expect(() => {
        setActiveSpanAttribute("harness.test.attempts", "invalid");
      }).toThrow("span_attr_invalid");
    });
    span.end();

    expect(exporter.getFinishedSpans()[0]?.attributes["harness.test.attempts"]).toBe(2);
  });

  it("does nothing when there is no active span", () => {
    expect(() => {
      setActiveSpanAttribute("harness.test.attempts", 1);
    }).not.toThrow();
  });

  it("converts attribute getter failures to value-free validation errors", () => {
    const definition = defineTestSpan();
    const attrs = new Proxy(
      {
        "harness.request.id": testId,
        "harness.test.count": 1,
        "harness.test.mode": "fast",
      },
      {
        get(target, key) {
          if (key === "harness.test.count") {
            throw new Error("sensitive getter value");
          }
          if (key === "harness.request.id") {
            return target["harness.request.id"];
          }
          if (key === "harness.test.mode") {
            return target["harness.test.mode"];
          }
          return undefined;
        },
      },
    );

    expect(() => invokeStart(definition, attrs)).toThrow("span_attr_invalid");
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it("returns definitions in registration order and looks them up by name", () => {
    const first = defineTestSpan();
    const second = defineSpan(
      "harness.test.second",
      { "harness.test.enabled": attr.bool() },
      testOwnerTask,
    );

    expect(listSpanDefinitions()).toEqual([first, second]);
    expect(lookupSpanDefinition(first.name)).toBe(first);
    expect(lookupSpanDefinition("harness.test.missing")).toBeUndefined();
  });

  it("ends spans after success and on errors without recording messages", async () => {
    const definition = defineTestSpan();
    const attrs: Parameters<typeof definition.start>[0] = {
      "harness.request.id": testId,
      "harness.test.count": 1,
      "harness.test.mode": "safe",
    };
    const harnessError = new X();
    const forgedHarnessError = new Error("forged sensitive message");
    Object.setPrototypeOf(forgedHarnessError, HarnessError.prototype);
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
    expect(spans[1]?.attributes["harness.error.code"]).toBe("x_failed");
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
    }).toThrow("span_registry_reset_forbidden");
    if (initialNodeEnv === undefined) {
      delete env.NODE_ENV;
    } else {
      env.NODE_ENV = initialNodeEnv;
    }
    expect(listSpanDefinitions()).toHaveLength(1);
  });

  it("registers registry errors as shared harness errors", () => {
    const registryError = new SpanRegistryError("span_duplicate");
    expect(registryError).toBeInstanceOf(HarnessError);
    expect(registryError.issues).toEqual([]);
    expect(Reflect.set(registryError, "code", "tool_failed")).toBe(false);
  });
});
