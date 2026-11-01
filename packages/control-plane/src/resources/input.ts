// SPDX-License-Identifier: Apache-2.0
import type { McpServer } from "@modelcontextprotocol/server";
import { readFileSync } from "node:fs";
import { HarnessError } from "@rovinos/schemas";
import { approvalAppResourcePath, MCP_APP_HTML_MIME_TYPE } from "./approval.js";

export const INPUT_RESOURCE_URI = "ui://harness/input/v1";

class InputResourceError extends HarnessError {
  override readonly code = "input_resource_unavailable";

  constructor() {
    super("The input app resource is unavailable.");
  }
}

/** Reads the built input app; the control plane must not start without this artifact. */
export function loadInputHtml(path = approvalAppResourcePath("input.html")): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new InputResourceError();
  }
}

/** Registers the built input app with the host-gated open-link capability. */
export function registerInputResource(server: McpServer, html = loadInputHtml()): void {
  server.registerResource(
    "harness-input",
    INPUT_RESOURCE_URI,
    {
      title: "Harness input",
      mimeType: MCP_APP_HTML_MIME_TYPE,
      _meta: { ui: { csp: {}, permissions: { openLinks: {} } } },
    },
    (uri) => ({
      contents: [{ uri: uri.href, mimeType: MCP_APP_HTML_MIME_TYPE, text: html }],
    }),
  );
}
