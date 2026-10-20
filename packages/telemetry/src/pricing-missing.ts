// SPDX-License-Identifier: Apache-2.0
import { context as otelContext } from "@opentelemetry/api";
import { logs, SeverityNumber, type Logger } from "@opentelemetry/api-logs";
import { Code } from "@harness/schemas";
import { attr } from "./attr.js";
import { defineLogRecord } from "./log-registry.js";

const pricingMissingDefinition = defineLogRecord("harness.model.pricing_missing", {
  "harness.model.provider": attr.code(),
  "harness.model.name": attr.code(),
});

/** Emits a bounded diagnostic when a model has no configured price. */
export function emitPricingMissing(
  provider: Code,
  model: Code,
  logger: Logger = logs.getLogger("@harness/core"),
): void {
  const attributes = pricingMissingDefinition.schema.parse({
    "harness.model.provider": provider,
    "harness.model.name": model,
  });
  try {
    logger.emit({
      body: Code.parse("pricing_missing"),
      eventName: pricingMissingDefinition.name,
      severityNumber: SeverityNumber.WARN,
      attributes,
      context: otelContext.active(),
    });
  } catch {
    return;
  }
}
