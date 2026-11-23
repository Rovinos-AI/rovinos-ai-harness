// SPDX-License-Identifier: Apache-2.0
import type { McpServer } from "@modelcontextprotocol/server";
import { readFileSync } from "node:fs";
import { HarnessError } from "@rovinos/schemas";
import { approvalAppResourcePath, MCP_APP_HTML_MIME_TYPE } from "./approval.js";

export const RUN_INSPECTOR_RESOURCE_URI = "ui://harness/run/v1";

class RunInspectorResourceError extends HarnessError {
  override readonly code = "run_inspector_resource_unavailable";

  constructor() {
    super("The run inspector resource is unavailable.");
  }
}

/** Reads the built run inspector; the control plane must not start without this artifact. */
export function loadRunInspectorHtml(path = approvalAppResourcePath("run-inspector.html")): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new RunInspectorResourceError();
  }
}

/** Registers the built run inspector as an MCP Apps HTML resource. */
export function registerRunInspectorResource(
  server: McpServer,
  html = loadRunInspectorHtml(),
): void {
  server.registerResource(
    "harness-run-inspector",
    RUN_INSPECTOR_RESOURCE_URI,
    {
      title: "Harness run inspector",
      mimeType: MCP_APP_HTML_MIME_TYPE,
      _meta: { ui: { csp: {}, permissions: {} } },
    },
    (uri) => ({
      contents: [{ uri: uri.href, mimeType: MCP_APP_HTML_MIME_TYPE, text: html }],
    }),
  );
}
