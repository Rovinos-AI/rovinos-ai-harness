// SPDX-License-Identifier: Apache-2.0
import { context as otelContext } from "@opentelemetry/api";
import { SeverityNumber, type Logger } from "@opentelemetry/api-logs";
import { Code } from "@harness/schemas";
import { attr } from "./attr.js";
import { defineLogRecord } from "./log-registry.js";
import { safeEventLogger } from "./safe-event-logs.js";

const controlPlaneAuditDefinition = defineLogRecord("harness.control_plane.operation", {
  "harness.auth.token.id": attr.code(),
  "harness.control_plane.tool": attr.code(),
  "harness.control_plane.outcome": attr.code(),
});

/** Emits a control-plane audit record containing only token, tool, and outcome codes. */
export function emitControlPlaneAudit(
  audit: {
    readonly tokenId: Code;
    readonly tool: Code;
    readonly outcome: Code;
  },
  logger: Logger = safeEventLogger,
): void {
  const attributes = controlPlaneAuditDefinition.schema.parse({
    "harness.auth.token.id": audit.tokenId,
    "harness.control_plane.tool": audit.tool,
    "harness.control_plane.outcome": audit.outcome,
  });
  logger.emit({
    body: Code.parse("control_plane_operation"),
    eventName: controlPlaneAuditDefinition.name,
    severityNumber: SeverityNumber.INFO,
    attributes,
    context: otelContext.active(),
  });
}
