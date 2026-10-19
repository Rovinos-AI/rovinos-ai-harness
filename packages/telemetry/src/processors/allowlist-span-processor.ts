// SPDX-License-Identifier: Apache-2.0
import {
  isSpanContextValid,
  SpanKind,
  SpanStatusCode,
  type Context,
  type SpanContext,
} from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { lookupSpanDefinition } from "../registry.js";
import { countDroppedTelemetry } from "../metrics.js";
import { Id, type TelemetryConfig } from "@harness/schemas";
import { assertSentinelGate, type SentinelGate } from "../sentinel/gate.js";
import { sanitizeAttributes, sanitizeResourceAttributes } from "./sanitize-attributes.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function isSpanLink(value: unknown): value is ReadableSpan["links"][number] {
  return isRecord(value) && isSpanContext(value.context);
}

function isInstrumentationScope(value: unknown): value is ReadableSpan["instrumentationScope"] {
  return isRecord(value) && typeof value.name === "string";
}

function isHrTime(value: unknown): value is ReadableSpan["startTime"] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every((component: unknown) => typeof component === "number" && Number.isFinite(component))
  );
}

function copyHrTime(value: unknown): ReadableSpan["startTime"] {
  if (!isHrTime(value)) {
    throw new TypeError("Span time is malformed.");
  }
  return [value[0], value[1]];
}

function isStatusCode(value: unknown): value is SpanStatusCode {
  return (
    value === SpanStatusCode.UNSET || value === SpanStatusCode.OK || value === SpanStatusCode.ERROR
  );
}

function isSpanKind(value: unknown): value is SpanKind {
  return (
    value === SpanKind.INTERNAL ||
    value === SpanKind.SERVER ||
    value === SpanKind.CLIENT ||
    value === SpanKind.PRODUCER ||
    value === SpanKind.CONSUMER
  );
}

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isSpanIdentityValid(span: ReadableSpan): boolean {
  return (
    typeof span.name === "string" &&
    isSpanKind(span.kind) &&
    isRecord(span.attributes) &&
    typeof span.spanContext === "function" &&
    (span.parentSpanContext === undefined || isSpanContext(span.parentSpanContext))
  );
}

function areSpanTimesValid(span: ReadableSpan): boolean {
  return isHrTime(span.startTime) && isHrTime(span.endTime) && isHrTime(span.duration);
}

function isSpanPayloadValid(span: ReadableSpan): boolean {
  return (
    isRecord(span.status) &&
    isStatusCode(span.status.code) &&
    Array.isArray(span.links) &&
    span.links.every(isSpanLink) &&
    Array.isArray(span.events)
  );
}

function isSpanMetadataValid(span: ReadableSpan): boolean {
  return (
    typeof span.ended === "boolean" &&
    isRecord(span.resource) &&
    isRecord(span.resource.attributes) &&
    isInstrumentationScope(span.instrumentationScope) &&
    isNonnegativeInteger(span.droppedAttributesCount) &&
    isNonnegativeInteger(span.droppedEventsCount) &&
    isNonnegativeInteger(span.droppedLinksCount)
  );
}

function isReadableSpanValid(span: ReadableSpan): boolean {
  return (
    isSpanIdentityValid(span) &&
    areSpanTimesValid(span) &&
    isSpanPayloadValid(span) &&
    isSpanMetadataValid(span)
  );
}

/**
 * Rebuilds a finished span using only attributes registered for its span name.
 *
 * @param span - Finished span from the OpenTelemetry SDK.
 * @param correlationEnabled - Whether telemetry correlation was explicitly enabled.
 * @returns A sanitized span, or `undefined` when it is unregistered or malformed.
 */
export function sanitizeSpan(
  span: ReadableSpan,
  correlationEnabled = false,
): ReadableSpan | undefined {
  try {
    if (!isReadableSpanValid(span)) {
      throw new TypeError("Readable span is malformed.");
    }

    const definition = lookupSpanDefinition(span.name);
    if (definition === undefined) {
      countDroppedTelemetry("unregistered_span");
      return undefined;
    }

    const attributes = sanitizeAttributes(definition, span.attributes, correlationEnabled);
    if (span.events.length > 0) {
      countDroppedTelemetry("event_stripped");
    }

    const spanContext = span.spanContext();
    if (!isSpanContext(spanContext)) {
      throw new TypeError("Span context is malformed.");
    }
    const sanitized: ReadableSpan = {
      name: span.name,
      kind: span.kind,
      spanContext: () => spanContext,
      ...(span.parentSpanContext === undefined
        ? {}
        : { parentSpanContext: span.parentSpanContext }),
      startTime: copyHrTime(span.startTime),
      endTime: copyHrTime(span.endTime),
      status: { code: span.status.code },
      attributes,
      links: span.links.map(({ context }) => ({ context })),
      events: [],
      duration: copyHrTime(span.duration),
      ended: span.ended,
      resource: resourceFromAttributes(sanitizeResourceAttributes(span.resource.attributes)),
      instrumentationScope: span.instrumentationScope,
      droppedAttributesCount: span.droppedAttributesCount,
      droppedEventsCount: span.droppedEventsCount,
      droppedLinksCount: span.droppedLinksCount,
    };

    return sanitized;
  } catch {
    countDroppedTelemetry("processor_error");
    return undefined;
  }
}

/** Sanitizes finished spans before forwarding them to the next processor. */
export class AllowlistSpanProcessor implements SpanProcessor {
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly next: SpanProcessor,
    private readonly options: {
      readonly gate?: SentinelGate;
      readonly telemetry?: TelemetryConfig;
      readonly nodeEnv?: string;
    } = {},
  ) {
    assertSentinelGate(options.gate, options.telemetry, options.nodeEnv);
  }

  /** Delegates span start notifications to the next processor. */
  onStart(span: Span, parentContext: Context): void {
    try {
      this.next.onStart(span, parentContext);
    } catch {
      countDroppedTelemetry("processor_error");
    }
  }

  /** Forwards only a sanitized span; malformed spans are counted and dropped. */
  onEnd(span: ReadableSpan): void {
    this.track(this.processSpan(span));
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

  private async processSpan(span: ReadableSpan): Promise<void> {
    try {
      const sanitized = sanitizeSpan(span, this.options.telemetry?.correlation.enabled === true);
      if (sanitized === undefined) {
        return;
      }
      if (this.options.gate !== undefined) {
        const runId = Id.safeParse(sanitized.attributes["harness.run.id"]);
        const result = await this.options.gate.check({
          ...(runId.success ? { runId: runId.data } : {}),
          text: serializeSpan(sanitized),
        });
        if (!result.ok) {
          countDroppedTelemetry("leak_sentinel");
          return;
        }
      }
      this.next.onEnd(sanitized);
    } catch {
      countDroppedTelemetry("processor_error");
    }
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

function serializeSpan(span: ReadableSpan): string {
  const fields = [span.name];
  appendAttributes(fields, span.attributes);
  for (const { context } of span.links) {
    fields.push(context.traceId, context.spanId);
  }
  appendAttributes(fields, span.resource.attributes);
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
