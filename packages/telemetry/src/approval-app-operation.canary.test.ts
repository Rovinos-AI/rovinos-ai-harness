// SPDX-License-Identifier: Apache-2.0
import { InMemoryLogRecordExporter } from "@opentelemetry/sdk-logs";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { Code } from "@harness/schemas";
import { describe, expect, it } from "vitest";
import { createTelemetrySdk } from "./sdk.js";
import { emitApprovalAppAudit } from "./approval-app-audit.js";

describe("approval app operation audit canary", () => {
  it("exports no values, pointers, or arguments", async () => {
    const exporter = new InMemoryLogRecordExporter();
    const sdk = createTelemetrySdk({
      spanExporter: new InMemorySpanExporter(),
      logExporter: exporter,
      telemetry: {
        sentinel: { enabled: false, minValueLength: 6 },
        correlation: { enabled: false },
      },
    });
    const audit = {
      tokenId: Code.parse("token.test"),
      tool: Code.parse("harness.approvals.reveal"),
      outcome: Code.parse("ok"),
      count: 1,
      value: "private-value-canary@example.test",
      pointer: "/private-pointer-canary",
      arguments: "private-arguments-canary",
    };

    try {
      emitApprovalAppAudit(audit, sdk.loggerProvider.getLogger("@harness/telemetry"));
      await sdk.forceFlush();

      const [record] = exporter.getFinishedLogRecords();
      expect(record?.eventName).toBe("harness.approval_app.operation");
      expect(record?.attributes).toEqual({
        "harness.auth.token.id": "token.test",
        "harness.approval.tool": "harness.approvals.reveal",
        "harness.approval.outcome": "ok",
        "harness.approval.value_count": 1,
      });
      const serializedRecord = JSON.stringify({
        body: record?.body,
        eventName: record?.eventName,
        attributes: record?.attributes,
      });
      expect(serializedRecord).not.toContain(audit.value);
      expect(serializedRecord).not.toContain(audit.pointer);
      expect(serializedRecord).not.toContain(audit.arguments);
    } finally {
      await sdk.loggerProvider.shutdown();
      await sdk.tracerProvider.shutdown();
    }
  });
});
