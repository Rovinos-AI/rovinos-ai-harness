// SPDX-License-Identifier: Apache-2.0
import { context as otelContext } from "@opentelemetry/api";
import { SeverityNumber, type Logger } from "@opentelemetry/api-logs";
import { Code } from "@harness/schemas";
import { attr } from "./attr.js";
import { defineLogRecord } from "./log-registry.js";
import { safeEventLogger } from "./safe-event-logs.js";

const approvalAppAuditDefinition = defineLogRecord("harness.approval_app.operation", {
  "harness.auth.token.id": attr.code(),
  "harness.approval.tool": attr.code(),
  "harness.approval.outcome": attr.code(),
  "harness.approval.value_count": attr.nonnegativeInt(),
});

/** Emits only bounded metadata for one app-only approval operation. */
export function emitApprovalAppAudit(
  audit: {
    readonly tokenId: Code;
    readonly tool: Code;
    readonly outcome: Code;
    readonly count: number;
  },
  logger: Logger = safeEventLogger,
): void {
  const attributes = approvalAppAuditDefinition.schema.parse({
    "harness.auth.token.id": audit.tokenId,
    "harness.approval.tool": audit.tool,
    "harness.approval.outcome": audit.outcome,
    "harness.approval.value_count": audit.count,
  });
  logger.emit({
    body: Code.parse("approval_app_operation"),
    eventName: approvalAppAuditDefinition.name,
    severityNumber: SeverityNumber.INFO,
    attributes,
    context: otelContext.active(),
  });
}
