// SPDX-License-Identifier: Apache-2.0
import type { Attributes, Context } from "@opentelemetry/api";
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
  span: ReadableSpan,
  shape: unknown,
  droppedReasons: TelemetryDropReason[],
): Attributes {
  if (typeof shape !== "object" || shape === null) {
    throw new TypeError("Span definition shape is malformed.");
  }

  const attributes: Attributes = {};
  for (const [key, value] of Object.entries(span.attributes)) {
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

function sanitizeResource(span: ReadableSpan) {
  const attributes: Attributes = {};
  for (const key of resourceAttributeNames) {
    const value = span.resource.attributes[key];
    if (value !== undefined) {
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
    const definition = lookupSpanDefinition(span.name);
    if (definition === undefined) {
      countDroppedTelemetry("unregistered_span");
      return undefined;
    }

    const droppedReasons: TelemetryDropReason[] = [];
    const attributes = sanitizeAttributes(span, definition.shape, droppedReasons);
    if (span.events.length > 0) {
      droppedReasons.push("event_stripped");
    }

    const spanContext = span.spanContext();
    const sanitized: ReadableSpan = {
      name: span.name,
      kind: span.kind,
      spanContext: () => spanContext,
      ...(span.parentSpanContext === undefined
        ? {}
        : { parentSpanContext: span.parentSpanContext }),
      startTime: [span.startTime[0], span.startTime[1]],
      endTime: [span.endTime[0], span.endTime[1]],
      status: { code: span.status.code },
      attributes,
      links: span.links.map(({ context }) => ({ context })),
      events: [],
      duration: [span.duration[0], span.duration[1]],
      ended: span.ended,
      resource: sanitizeResource(span),
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
