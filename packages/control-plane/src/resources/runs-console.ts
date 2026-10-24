// SPDX-License-Identifier: Apache-2.0
import type { McpServer } from "@modelcontextprotocol/server";
import { readFileSync } from "node:fs";
import { HarnessError } from "@rovinos/schemas";
import { approvalAppResourcePath, MCP_APP_HTML_MIME_TYPE } from "./approval.js";

export const RUNS_CONSOLE_RESOURCE_URI = "ui://harness/runs/v1";

class RunsConsoleResourceError extends HarnessError {
  override readonly code = "runs_console_resource_unavailable";

  constructor() {
    super("The runs console resource is unavailable.");
  }
}

/** Reads the built runs console; the server must not start without this artifact. */
export function loadRunsConsoleHtml(path = approvalAppResourcePath("runs-console.html")): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new RunsConsoleResourceError();
  }
}

/** Registers the built runs console as an MCP Apps HTML resource. */
export function registerRunsConsoleResource(server: McpServer, html = loadRunsConsoleHtml()): void {
  server.registerResource(
    "harness-runs-console",
    RUNS_CONSOLE_RESOURCE_URI,
    {
      title: "Harness runs",
      mimeType: MCP_APP_HTML_MIME_TYPE,
      _meta: { ui: { csp: {}, permissions: {} } },
    },
    (uri) => ({
      contents: [{ uri: uri.href, mimeType: MCP_APP_HTML_MIME_TYPE, text: html }],
    }),
  );
}
