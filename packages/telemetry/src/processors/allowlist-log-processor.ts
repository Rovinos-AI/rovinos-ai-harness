// SPDX-License-Identifier: Apache-2.0
import { isSpanContextValid, type SpanContext, type Context } from "@opentelemetry/api";
import type { SeverityNumber } from "@opentelemetry/api-logs";
import { resourceFromAttributes } from "@opentelemetry/resources";
import type { LogRecordProcessor, ReadWriteLogRecord } from "@opentelemetry/sdk-logs";
import { Code } from "@harness/schemas";
import { countDroppedTelemetry } from "../metrics.js";
import { lookupLogDefinition, type LogRecordDefinition } from "../log-registry.js";
import { sanitizeAttributes, sanitizeResourceAttributes } from "./sanitize-attributes.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHrTime(value: unknown): value is readonly [number, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every((component: unknown) => typeof component === "number" && Number.isFinite(component))
  );
}

function isInstrumentationScope(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && typeof value.name === "string";
}

function isSpanContext(value: unknown): value is SpanContext {
  if (!isRecord(value)) {
    return false;
  }
  const { traceId, spanId, traceFlags } = value;
  return (
    typeof traceId === "string" &&
    typeof spanId === "string" &&
    typeof traceFlags === "number" &&
    isSpanContextValid({ traceId, spanId, traceFlags })
  );
}

function isSeverityNumber(value: unknown): value is SeverityNumber {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 24;
}

function lookupDefinition(record: Record<string, unknown>): LogRecordDefinition | undefined {
  const eventName = Code.safeParse(record.eventName);
  if (!eventName.success) {
    return undefined;
  }
  return lookupLogDefinition(eventName.data);
}

function sanitizedCopy(
  record: Record<string, unknown>,
  definition: LogRecordDefinition,
): ReadWriteLogRecord {
  if (
    !isHrTime(record.hrTime) ||
    !isHrTime(record.hrTimeObserved) ||
    !isRecord(record.resource) ||
    !isRecord(record.resource.attributes) ||
    !isInstrumentationScope(record.instrumentationScope) ||
    !isRecord(record.attributes) ||
    typeof record.droppedAttributesCount !== "number" ||
    !Number.isInteger(record.droppedAttributesCount) ||
    record.droppedAttributesCount < 0
  ) {
    throw new TypeError("Log record is malformed.");
  }

  const attributes = sanitizeAttributes(definition, record.attributes);
  const spanContext = isSpanContext(record.spanContext) ? record.spanContext : undefined;
  const severityNumber = isSeverityNumber(record.severityNumber)
    ? record.severityNumber
    : undefined;
  const sanitized: ReadWriteLogRecord = {
    hrTime: [record.hrTime[0], record.hrTime[1]],
    hrTimeObserved: [record.hrTimeObserved[0], record.hrTimeObserved[1]],
    ...(spanContext === undefined ? {} : { spanContext }),
    resource: resourceFromAttributes(sanitizeResourceAttributes(record.resource.attributes)),
    instrumentationScope: { name: "@harness/telemetry" },
    attributes,
    ...(severityNumber === undefined ? {} : { severityNumber }),
    body: definition.name,
    eventName: definition.name,
    droppedAttributesCount: record.droppedAttributesCount,
    setAttribute: () => sanitized,
    setAttributes: () => sanitized,
    setBody: () => sanitized,
    setEventName: () => sanitized,
    setSeverityNumber: () => sanitized,
    setSeverityText: () => sanitized,
  };
  return Object.freeze(sanitized);
}

/**
 * Forwards only copied log records whose event kind has a registered definition.
 *
 * @param next - The downstream log-record processor or exporter processor.
 */
export class AllowlistLogRecordProcessor implements LogRecordProcessor {
  constructor(private readonly next: LogRecordProcessor) {}

  /** Sanitizes log records before forwarding them; malformed and unregistered records are dropped. */
  onEmit(record: ReadWriteLogRecord, context?: Context): void {
    try {
      const input: unknown = record;
      if (!isRecord(input)) {
        throw new TypeError("Log record is malformed.");
      }
      const definition = lookupDefinition(input);
      if (definition === undefined) {
        countDroppedTelemetry("unregistered_log_record");
        return;
      }
      this.next.onEmit(sanitizedCopy(input, definition), context);
    } catch {
      countDroppedTelemetry("processor_error");
    }
  }

  /** Flushes the downstream processor. */
  forceFlush(): Promise<void> {
    return this.next.forceFlush();
  }

  /** Shuts down the downstream processor. */
  shutdown(): Promise<void> {
    return this.next.shutdown();
  }
}
