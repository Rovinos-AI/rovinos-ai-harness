// SPDX-License-Identifier: Apache-2.0
import type { McpServer } from "@modelcontextprotocol/server";
import { readFileSync } from "node:fs";
import { HarnessError } from "@rovinos/schemas";
import { approvalAppResourcePath, MCP_APP_HTML_MIME_TYPE } from "./approval.js";

export const REPORTS_RESOURCE_URI = "ui://harness/reports/v1";

class ReportsResourceError extends HarnessError {
  override readonly code = "reports_resource_unavailable";

  constructor() {
    super("The reports app resource is unavailable.");
  }
}

/** Reads the built reports app; the server must not start without this artifact. */
export function loadReportsHtml(path = approvalAppResourcePath("reports.html")): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new ReportsResourceError();
  }
}

/** Registers the built report viewer as an MCP Apps HTML resource. */
export function registerReportsResource(server: McpServer, html = loadReportsHtml()): void {
  server.registerResource(
    "harness-reports",
    REPORTS_RESOURCE_URI,
    {
      title: "Harness reports",
      mimeType: MCP_APP_HTML_MIME_TYPE,
      _meta: { ui: { csp: {}, permissions: {} } },
    },
    (uri) => ({
      contents: [{ uri: uri.href, mimeType: MCP_APP_HTML_MIME_TYPE, text: html }],
    }),
  );
}
