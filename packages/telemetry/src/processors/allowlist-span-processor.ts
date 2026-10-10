// SPDX-License-Identifier: Apache-2.0
import {
  isSpanContextValid,
  SpanKind,
  SpanStatusCode,
  type Attributes,
  type Context,
  type SpanContext,
} from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { lookupSpanDefinition } from "../registry.js";
import { countDroppedTelemetry, type TelemetryDropReason } from "../metrics.js";

const resourceAttributeNames = [
  "service.name",
  "service.version",
  "harness.policy.version",
  "telemetry.sdk.name",
  "telemetry.sdk.language",
  "telemetry.sdk.version",
] as const;

function isAttributeValue(value: unknown): value is string | number | boolean {
  return (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

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

function isSafeParser(value: unknown): value is { safeParse(input: unknown): unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    "safeParse" in value &&
    typeof value.safeParse === "function"
  );
}

function isSuccessfulParse(
  value: unknown,
): value is { success: true; data: unknown } | { success: false } {
  return (
    typeof value === "object" &&
    value !== null &&
    "success" in value &&
    (value.success === false || (value.success === true && "data" in value))
  );
}

function sanitizeAttributes(
  sourceAttributes: Record<string, unknown>,
  shape: unknown,
  droppedReasons: TelemetryDropReason[],
): Attributes {
  if (typeof shape !== "object" || shape === null) {
    throw new TypeError("Span definition shape is malformed.");
  }

  const attributes: Attributes = {};
  for (const [key, value] of Object.entries(sourceAttributes)) {
    if (!Object.hasOwn(shape, key)) {
      droppedReasons.push("unregistered_attr");
      continue;
    }

    const schema: unknown = Reflect.get(shape, key);
    if (!isSafeParser(schema)) {
      droppedReasons.push("invalid_attr");
      continue;
    }

    const parsed: unknown = schema.safeParse(value);
    if (!isSuccessfulParse(parsed) || !parsed.success || !isAttributeValue(parsed.data)) {
      droppedReasons.push("invalid_attr");
      continue;
    }

    attributes[key] = parsed.data;
  }
  return attributes;
}

function sanitizeResource(sourceAttributes: Record<string, unknown>) {
  const attributes: Attributes = {};
  for (const key of resourceAttributeNames) {
    const value: unknown = sourceAttributes[key];
    if (isAttributeValue(value)) {
      attributes[key] = value;
    }
  }
  return resourceFromAttributes(attributes);
}

/**
 * Rebuilds a finished span using only attributes registered for its span name.
 *
 * @param span - Finished span from the OpenTelemetry SDK.
 * @returns A sanitized span, or `undefined` when it is unregistered or malformed.
 */
export function sanitizeSpan(span: ReadableSpan): ReadableSpan | undefined {
  try {
    if (!isReadableSpanValid(span)) {
      throw new TypeError("Readable span is malformed.");
    }

    const definition = lookupSpanDefinition(span.name);
    if (definition === undefined) {
      countDroppedTelemetry("unregistered_span");
      return undefined;
    }

    const droppedReasons: TelemetryDropReason[] = [];
    const attributes = sanitizeAttributes(span.attributes, definition.shape, droppedReasons);
    if (span.events.length > 0) {
      droppedReasons.push("event_stripped");
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
      resource: sanitizeResource(span.resource.attributes),
      instrumentationScope: span.instrumentationScope,
      droppedAttributesCount: span.droppedAttributesCount,
      droppedEventsCount: span.droppedEventsCount,
      droppedLinksCount: span.droppedLinksCount,
    };

    for (const reason of droppedReasons) {
      countDroppedTelemetry(reason);
    }
    return sanitized;
  } catch {
    countDroppedTelemetry("processor_error");
    return undefined;
  }
}

/** Sanitizes finished spans before forwarding them to the next processor. */
export class AllowlistSpanProcessor implements SpanProcessor {
  constructor(private readonly next: SpanProcessor) {}

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
    try {
      const sanitized = sanitizeSpan(span);
      if (sanitized !== undefined) {
        this.next.onEnd(sanitized);
      }
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
