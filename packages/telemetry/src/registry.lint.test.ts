// SPDX-License-Identifier: Apache-2.0
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import type { LogRecordProcessor, ReadWriteLogRecord } from "@opentelemetry/sdk-logs";
import type { TelemetryConfig } from "@harness/schemas";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { attr, isSafeAttr } from "./attr.js";
import { listLogDefinitions, type LogRecordDefinition } from "./log-registry.js";
import {
  __registerUnsafeSpanForTests,
  defineSpan,
  listSpanDefinitions,
} from "./registry.js";
import { safeEventSchemas } from "./safe-event.js";
import "./safe-event-logs.js";
import { AllowlistLogRecordProcessor } from "./processors/allowlist-log-processor.js";
import { sanitizeSpan } from "./processors/allowlist-span-processor.js";

const disabledTelemetry: TelemetryConfig = {
  sentinel: { minValueLength: 6, enabled: false },
};

const propertySpan = defineSpan("harness.test.random_string_property", {
  "harness.test.id": attr.id(),
  "harness.test.code": attr.code(),
  "harness.test.enum": attr.enum(["allowed", "bounded"]),
  "harness.test.count": attr.int(),
  "harness.test.enabled": attr.bool(),
});

const adversarialStrings = fc.oneof(
  fc.string({ maxLength: 4096 }),
  fc.emailAddress(),
  fc.constant("alexandria@example.test"),
  fc.constant("🧪🙂".repeat(128)),
  fc.constant("x".repeat(4096)),
  fc.constant(`${"a".repeat(20)}.${"b".repeat(20)}.${"c".repeat(20)}`),
);

function assertSafeSchema(schema: z.core.$ZodType, owner: string, field: string): void {
  if (isSafeAttr(schema)) {
    return;
  }
  if (schema instanceof z.ZodObject) {
    for (const [name, child] of Object.entries(schema.shape)) {
      assertSafeSchema(child, owner, `${field}.${name}`);
    }
    return;
  }
  if (schema instanceof z.ZodArray) {
    assertSafeSchema(schema.element, owner, `${field}[]`);
    return;
  }
  throw new Error(`${owner} field ${field} is not constrained by an attr helper`);
}

function assertAllRegisteredSchemasSafe(): void {
  for (const definition of listSpanDefinitions()) {
    for (const [field, schema] of Object.entries(definition.shape)) {
      assertSafeSchema(schema, `span ${definition.name}`, field);
    }
  }
  for (const definition of listLogDefinitions()) {
    for (const [field, schema] of Object.entries(definition.shape)) {
      assertSafeSchema(schema, `log ${definition.name}`, field);
    }
  }
  for (const schema of safeEventSchemas) {
    const kind = schema.shape.kind.options.join("|");
    for (const [field, fieldSchema] of Object.entries(schema.shape)) {
      assertSafeSchema(fieldSchema, `SafeEvent ${kind}`, field);
    }
  }
}

function makeReadableSpan(name: string, attributes: Record<string, string>): ReadableSpan {
  return {
    name,
    kind: SpanKind.INTERNAL,
    spanContext: () => ({
      traceId: "1".repeat(32),
      spanId: "2".repeat(16),
      traceFlags: 1,
    }),
    startTime: [0, 0],
    endTime: [1, 0],
    status: { code: SpanStatusCode.UNSET },
    attributes,
    links: [],
    events: [],
    duration: [1, 0],
    ended: true,
    resource: resourceFromAttributes({}),
    instrumentationScope: { name: "@harness/telemetry-test" },
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  };
}

function makeRawLogRecord(
  definition: LogRecordDefinition,
  attributes: Record<string, string>,
): ReadWriteLogRecord {
  const record: ReadWriteLogRecord = {
    hrTime: [0, 0],
    hrTimeObserved: [1, 0],
    resource: resourceFromAttributes({}),
    instrumentationScope: { name: "@harness/telemetry-test" },
    attributes,
    body: "untrusted body",
    eventName: definition.name,
    droppedAttributesCount: 0,
    setAttribute: () => record,
    setAttributes: () => record,
    setBody: () => record,
    setEventName: () => record,
    setSeverityNumber: () => record,
    setSeverityText: () => record,
  };
  return record;
}

function assertSurvivingStringsMatchSchema(
  definition: { readonly shape: object },
  attributes: Record<string, unknown>,
): void {
  for (const [field, value] of Object.entries(attributes)) {
    if (typeof value === "string") {
      const schema: unknown = Reflect.get(definition.shape, field);
      expect(schema instanceof z.ZodType).toBe(true);
      if (schema instanceof z.ZodType) {
        expect(schema.safeParse(value).success).toBe(true);
      }
    }
  }
}

describe("telemetry schema lint", () => {
  it("requires attr helpers for all registry and SafeEvent schema fields", () => {
    expect(listSpanDefinitions()).toContain(propertySpan);
    expect(listLogDefinitions().length).toBeGreaterThan(0);
    assertAllRegisteredSchemasSafe();
  });

  for (const definition of listSpanDefinitions()) {
    it(`drops unsafe random strings from span ${definition.name}`, () => {
      fc.assert(
        fc.property(adversarialStrings, (value) => {
          const attributes = Object.fromEntries(
            Object.keys(definition.shape).map((field) => [field, value]),
          );
          const sanitized = sanitizeSpan(makeReadableSpan(definition.name, attributes));
          expect(sanitized).toBeDefined();
          assertSurvivingStringsMatchSchema(definition, sanitized?.attributes ?? {});
        }),
        { numRuns: 500 },
      );
    });
  }

  for (const definition of listLogDefinitions()) {
    it(`drops unsafe random strings from log ${definition.name}`, async () => {
      const forwarded: ReadWriteLogRecord[] = [];
      const next = {
        onEmit(record: ReadWriteLogRecord) {
          forwarded.push(record);
        },
        forceFlush: async () => undefined,
        shutdown: async () => undefined,
      } satisfies LogRecordProcessor;
      const processor = new AllowlistLogRecordProcessor(next, {
        telemetry: disabledTelemetry,
      });

      await fc.assert(
        fc.asyncProperty(adversarialStrings, async (value) => {
          const attributes = Object.fromEntries(
            Object.keys(definition.shape).map((field) => [field, value]),
          );
          processor.onEmit(makeRawLogRecord(definition, attributes));
          await processor.forceFlush();
          const sanitized = forwarded.at(-1);
          expect(sanitized).toBeDefined();
          assertSurvivingStringsMatchSchema(definition, sanitized?.attributes ?? {});
        }),
        { numRuns: 500 },
      );
    });
  }

  it("fails schema lint when an unsafe span is registered through the test hook", () => {
    __registerUnsafeSpanForTests("harness.test.unsafe_definition", {
      "harness.test.free_text": z.string(),
    });
    expect(assertAllRegisteredSchemasSafe).toThrow(
      "span harness.test.unsafe_definition field harness.test.free_text",
    );
  });
});
