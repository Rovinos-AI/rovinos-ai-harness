// SPDX-License-Identifier: Apache-2.0
import { createTelemetrySdk, type TelemetrySdkOptions } from "@harness/telemetry";
import { Id, JsonValue } from "@harness/schemas";
import { ExportResultCode } from "@opentelemetry/core";
import { describe, expect, it } from "vitest";
import { WebFetchTool } from "./web-fetch-tool.js";

describe("web.fetch URL telemetry canary", () => {
  it("keeps URL and hostname canaries out of exported spans and logs", async () => {
    const canary = "https://docs.example.test/page?secret=synthetic-web-fetch-url-canary";
    const spans: string[] = [];
    const logs: string[] = [];
    const spanExporter: TelemetrySdkOptions["spanExporter"] = {
      export: (finished, callback) => {
        spans.push(...finished.map(({ name, attributes }) => JSON.stringify({ name, attributes })));
        callback({ code: ExportResultCode.SUCCESS });
      },
      shutdown: () => Promise.resolve(),
    };
    const logExporter: TelemetrySdkOptions["logExporter"] = {
      export: (finished, callback) => {
        logs.push(
          ...finished.map(({ eventName, attributes }) => JSON.stringify({ eventName, attributes })),
        );
        callback({ code: ExportResultCode.SUCCESS });
      },
      forceFlush: () => Promise.resolve(),
      shutdown: () => Promise.resolve(),
    };
    const telemetry = createTelemetrySdk({
      spanExporter,
      logExporter,
      telemetry: {
        sentinel: { enabled: false, minValueLength: 6 },
        correlation: { enabled: false },
      },
    });
    const tool = new WebFetchTool({
      backend: {
        fetch: () =>
          Promise.resolve({
            url: "https://docs.example.test/page",
            status: 200,
            contentType: "text/plain",
            text: "untrusted",
            truncated: false,
            untrusted: true,
            hiddenTextDropped: 0,
          }),
      },
    });

    try {
      await tool.execute(
        {
          callId: Id.parse("00000000000000000000000001"),
          toolId: "web.fetch",
          args: JsonValue.parse({ url: canary }),
        },
        { runId: Id.parse("00000000000000000000000002"), signal: new AbortController().signal },
      );
      await telemetry.forceFlush();
      expect(`${spans.join("\n")}\n${logs.join("\n")}`).not.toContain(canary);
      expect(`${spans.join("\n")}\n${logs.join("\n")}`).not.toContain("docs.example.test");
    } finally {
      await telemetry.tracerProvider.shutdown();
      await telemetry.loggerProvider.shutdown();
    }
  });
});
