// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import type { LogRecordProcessor, ReadWriteLogRecord } from "@opentelemetry/sdk-logs";
import type { TelemetryConfig } from "@harness/schemas";
import fc from "fast-check";
import { z } from "zod";
import { getAttrMeta, isSafeAttr } from "../attr.js";
import { listLogDefinitions, type LogRecordDefinition } from "../log-registry.js";
import { listSpanDefinitions } from "../registry.js";
import { safeEventSchemas } from "../safe-event.js";
import { AllowlistLogRecordProcessor } from "../processors/allowlist-log-processor.js";
import { sanitizeSpan } from "../processors/allowlist-span-processor.js";

const disabledTelemetry: TelemetryConfig = {
  sentinel: { minValueLength: 6, enabled: false },
  correlation: { enabled: false },
};

export const adversarialStrings = fc.oneof(
  fc.string({ maxLength: 4096 }),
  fc.string({ unit: "grapheme", maxLength: 4096 }),
  fc.emailAddress(),
  fc.constant("alexandria@example.test"),
  fc.constant("🧪🙂".repeat(128)),
  fc.constant("x".repeat(4096)),
  fc.stringMatching(/^[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}$/u),
  fc.constant("A".repeat(26)),
  fc.constant("harness.valid.code"),
);

interface RegistryDefinition {
  readonly name: string;
  readonly shape: unknown;
}

function isZodSchema(value: unknown): value is z.ZodType {
  return value instanceof z.ZodType;
}

function assertSafeSchema(schema: z.core.$ZodType, owner: string, field: string): void {
  if (isSafeAttr(schema)) {
    return;
  }
  if (schema instanceof z.ZodObject) {
    for (const name of Object.keys(schema.shape)) {
      const child: unknown = Reflect.get(schema.shape, name);
      assert.ok(isZodSchema(child), `${owner} field ${field}.${name} is not a Zod schema`);
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

function assertShapeSafe(shape: unknown, owner: string): void {
  assert.ok(typeof shape === "object" && shape !== null, `${owner} has no attribute shape`);
  for (const field of Object.keys(shape)) {
    const schema: unknown = Reflect.get(shape, field);
    assert.ok(isZodSchema(schema), `${owner} field ${field} is not a Zod schema`);
    assertSafeSchema(schema, owner, field);
  }
}

/**
 * Verifies that every field in the supplied telemetry schema catalog uses an attr helper.
 *
 * @param spanDefinitions - Span definitions to check.
 * @param logDefinitions - Log definitions to check.
 * @param safeEvents - SafeEvent schemas to check.
 */
export function assertSchemaCatalogSafe(
  spanDefinitions: readonly RegistryDefinition[],
  logDefinitions: readonly RegistryDefinition[],
  safeEvents: readonly z.ZodObject[],
): void {
  for (const definition of spanDefinitions) {
    assertShapeSafe(definition.shape, `span ${definition.name}`);
  }
  for (const definition of logDefinitions) {
    assertShapeSafe(definition.shape, `log ${definition.name}`);
  }
  for (const schema of safeEvents) {
    const kindSchema: unknown = Reflect.get(schema.shape, "kind");
    const kind = kindSchema instanceof z.ZodEnum ? kindSchema.options.join("|") : "unknown";
    assertShapeSafe(schema.shape, `SafeEvent ${kind}`);
  }
}

/** Verifies that all currently registered schemas and SafeEvent schemas use attr helpers. */
export function assertRegisteredSchemasSafe(): void {
  assertSchemaCatalogSafe(listSpanDefinitions(), listLogDefinitions(), safeEventSchemas);
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
  definition: RegistryDefinition,
  attributes: Record<string, unknown>,
): void {
  for (const [field, value] of Object.entries(attributes)) {
    if (typeof value !== "string") {
      continue;
    }
    assert.ok(
      typeof definition.shape === "object" && definition.shape !== null,
      "A registry definition has no attribute shape",
    );
    const schema: unknown = Reflect.get(definition.shape, field);
    assert.ok(isZodSchema(schema), `Surviving attribute ${field} has no schema`);
    assert.equal(schema.safeParse(value).success, true);
  }
}

function assertUnregisteredAndNonStringAttrsDropped(
  definition: RegistryDefinition,
  attributes: Record<string, unknown>,
): void {
  assert.equal(Object.hasOwn(attributes, "harness.unregistered"), false);
  assert.ok(typeof definition.shape === "object" && definition.shape !== null);
  for (const field of Object.keys(definition.shape)) {
    const schema: unknown = Reflect.get(definition.shape, field);
    assert.ok(isZodSchema(schema));
    const kind = getAttrMeta(schema)?.kind;
    if (kind === "int" || kind === "num" || kind === "bool") {
      assert.equal(Object.hasOwn(attributes, field), false);
    }
  }
}

function makeStringAttributes(
  definition: RegistryDefinition,
  value: string,
): Record<string, string> {
  assert.ok(typeof definition.shape === "object" && definition.shape !== null);
  const entries: [string, string][] = Object.keys(definition.shape).map((field) => [field, value]);
  entries.push(["harness.unregistered", value]);
  return Object.fromEntries(entries);
}

/**
 * Exercises span sanitization with 500 adversarial strings and asserts only valid fields survive.
 *
 * @param definition - Registered span definition to exercise.
 */
export function assertRandomStringsDroppedFromSpan(definition: RegistryDefinition): void {
  fc.assert(
    fc.property(adversarialStrings, (value) => {
      const sanitized = sanitizeSpan(
        makeReadableSpan(definition.name, makeStringAttributes(definition, value)),
      );
      assert.ok(sanitized);
      assertSurvivingStringsMatchSchema(definition, sanitized.attributes);
      assertUnregisteredAndNonStringAttrsDropped(definition, sanitized.attributes);
    }),
    { numRuns: 500 },
  );
}

/**
 * Exercises log sanitization with 500 adversarial strings and asserts only valid fields survive.
 *
 * @param definition - Registered log definition to exercise.
 */
export async function assertRandomStringsDroppedFromLog(
  definition: LogRecordDefinition,
): Promise<void> {
  const forwarded: ReadWriteLogRecord[] = [];
  const next = {
    onEmit(record: ReadWriteLogRecord) {
      forwarded.push(record);
    },
    forceFlush: () => Promise.resolve(),
    shutdown: () => Promise.resolve(),
  } satisfies LogRecordProcessor;
  const processor = new AllowlistLogRecordProcessor(next, {
    telemetry: disabledTelemetry,
  });

  await fc.assert(
    fc.asyncProperty(adversarialStrings, async (value) => {
      processor.onEmit(makeRawLogRecord(definition, makeStringAttributes(definition, value)));
      await processor.forceFlush();
      const record = forwarded.at(-1);
      assert.ok(record);
      assertSurvivingStringsMatchSchema(definition, record.attributes);
      assertUnregisteredAndNonStringAttrsDropped(definition, record.attributes);
    }),
    { numRuns: 500 },
  );
}
