// SPDX-License-Identifier: Apache-2.0
import { isSpanContextValid, type SpanContext, type Context } from "@opentelemetry/api";
import type { SeverityNumber } from "@opentelemetry/api-logs";
import { resourceFromAttributes } from "@opentelemetry/resources";
import type { LogRecordProcessor, ReadWriteLogRecord } from "@opentelemetry/sdk-logs";
import { Code, Id, type TelemetryConfig } from "@rovinos/schemas";
import { countDroppedTelemetry } from "../metrics.js";
import { assertSentinelGate, type SentinelGate } from "../sentinel/gate.js";
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
  correlationEnabled: boolean,
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

  const attributes = sanitizeAttributes(definition, record.attributes, correlationEnabled);
  const spanContext = isSpanContext(record.spanContext) ? record.spanContext : undefined;
  const severityNumber = isSeverityNumber(record.severityNumber)
    ? record.severityNumber
    : undefined;
  const sanitized: ReadWriteLogRecord = {
    hrTime: [record.hrTime[0], record.hrTime[1]],
    hrTimeObserved: [record.hrTimeObserved[0], record.hrTimeObserved[1]],
    ...(spanContext === undefined ? {} : { spanContext }),
    resource: resourceFromAttributes(sanitizeResourceAttributes(record.resource.attributes)),
    instrumentationScope: { name: "@rovinos/telemetry" },
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
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly next: LogRecordProcessor,
    private readonly options: {
      readonly gate?: SentinelGate;
      readonly telemetry?: TelemetryConfig;
      readonly nodeEnv?: string;
    } = {},
  ) {
    assertSentinelGate(options.gate, options.telemetry, options.nodeEnv);
  }

  /** Sanitizes log records before forwarding them; malformed and unregistered records are dropped. */
  onEmit(record: ReadWriteLogRecord, context?: Context): void {
    this.track(this.processRecord(record, context));
  }

  private async processRecord(record: ReadWriteLogRecord, context?: Context): Promise<void> {
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
      const sanitized = sanitizedCopy(
        input,
        definition,
        this.options.telemetry?.correlation.enabled === true,
      );
      if (this.options.gate !== undefined && definition.name !== "harness.sentinel.trip") {
        const runId = Id.safeParse(sanitized.attributes["harness.run.id"]);
        const result = await this.options.gate.check({
          ...(runId.success ? { runId: runId.data } : {}),
          text: serializeLogRecord(sanitized),
        });
        if (!result.ok) {
          countDroppedTelemetry("leak_sentinel");
          return;
        }
      }
      this.next.onEmit(sanitized, context);
    } catch {
      countDroppedTelemetry("processor_error");
    }
  }

  /** Flushes the downstream processor. */
  async forceFlush(): Promise<void> {
    await this.drain();
    await this.next.forceFlush();
  }

  /** Shuts down the downstream processor. */
  async shutdown(): Promise<void> {
    await this.drain();
    await this.next.shutdown();
  }

  private track(task: Promise<void>): void {
    this.pending.add(task);
    void task.then(() => this.pending.delete(task));
  }

  private async drain(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all(this.pending);
    }
  }
}

function serializeLogRecord(record: ReadWriteLogRecord): string {
  const fields = [record.eventName ?? "", canonicalValue(record.body)];
  appendAttributes(fields, record.attributes);
  if (record.spanContext !== undefined) {
    fields.push(record.spanContext.traceId, record.spanContext.spanId);
  }
  appendAttributes(fields, record.resource.attributes);
  return fields.join("\u0000");
}

function appendAttributes(fields: string[], attributes: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(attributes).sort(([left], [right]) =>
    left < right ? -1 : Number(left > right),
  )) {
    fields.push(key, canonicalValue(value));
  }
}

function canonicalValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value);
}
