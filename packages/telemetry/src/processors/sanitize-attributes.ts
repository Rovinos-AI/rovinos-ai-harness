// SPDX-License-Identifier: Apache-2.0
import type { Attributes } from "@opentelemetry/api";
import { countDroppedTelemetry } from "../metrics.js";

interface AttributeDefinition {
  readonly shape: unknown;
}

const resourceAttributeNames = [
  "service.name",
  "service.version",
  "harness.policy.version",
  "telemetry.sdk.name",
  "telemetry.sdk.language",
  "telemetry.sdk.version",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

/**
 * Copies only attributes registered in a definition and accepted by its schema.
 *
 * @param definition - The registered span or log-record definition.
 * @param attrs - The untrusted attributes to sanitize.
 * @param correlationEnabled - Whether telemetry correlation was explicitly enabled.
 * @returns A new set containing only safe, valid scalar attributes.
 */
export function sanitizeAttributes(
  definition: AttributeDefinition,
  attrs: unknown,
  correlationEnabled = false,
): Attributes {
  if (!isRecord(definition.shape) || !isRecord(attrs)) {
    throw new TypeError("Telemetry attributes are malformed.");
  }

  const sanitized: Attributes = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "harness.user.pseudonym" && !correlationEnabled) {
      countDroppedTelemetry("correlation_disabled");
      continue;
    }

    if (!Object.hasOwn(definition.shape, key)) {
      countDroppedTelemetry("unregistered_attr");
      continue;
    }

    const schema = Reflect.get(definition.shape, key);
    if (!isSafeParser(schema)) {
      countDroppedTelemetry("invalid_attr");
      continue;
    }

    const parsed: unknown = schema.safeParse(value);
    if (!isSuccessfulParse(parsed) || !parsed.success || !isAttributeValue(parsed.data)) {
      countDroppedTelemetry("invalid_attr");
      continue;
    }

    sanitized[key] = parsed.data;
  }
  return sanitized;
}

/**
 * Copies only the resource attributes allowlisted for spans and log records.
 *
 * @param sourceAttributes - Untrusted resource attributes.
 * @returns A new set containing only allowlisted scalar resource attributes.
 */
export function sanitizeResourceAttributes(sourceAttributes: unknown): Attributes {
  if (!isRecord(sourceAttributes)) {
    throw new TypeError("Telemetry resource attributes are malformed.");
  }

  const sanitized: Attributes = {};
  for (const key of resourceAttributeNames) {
    const value: unknown = sourceAttributes[key];
    if (isAttributeValue(value)) {
      sanitized[key] = value;
    }
  }
  return sanitized;
}
