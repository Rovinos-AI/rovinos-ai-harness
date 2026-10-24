// SPDX-License-Identifier: Apache-2.0
import type { McpServer } from "@modelcontextprotocol/server";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { HarnessError } from "@rovinos/schemas";

export const APPROVAL_RESOURCE_URI = "ui://harness/approval/v1";
export const MCP_APP_HTML_MIME_TYPE = "text/html;profile=mcp-app";

/** Resolves the approval app asset from workspace, bundled image, or CLI package layouts. */
export function approvalAppResourcePath(
  filename: "approval.html" | "runs-console.html",
  moduleUrl = import.meta.url,
): string {
  const fallback = new URL(`../approval-app/dist/${filename}`, moduleUrl);
  const candidates = [
    new URL(`../../../approval-app/dist/${filename}`, moduleUrl),
    new URL(`../packages/approval-app/dist/${filename}`, moduleUrl),
    fallback,
  ];
  for (const candidate of candidates) {
    const path = fileURLToPath(candidate);
    if (existsSync(path)) {
      return path;
    }
  }
  return fileURLToPath(fallback);
}

class ApprovalResourceError extends HarnessError {
  override readonly code = "approval_resource_unavailable";

  constructor() {
    super("The approval app resource is unavailable.");
  }
}

/** Reads the built approval app; the server must not start without this artifact. */
export function loadApprovalHtml(path = approvalAppResourcePath("approval.html")): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new ApprovalResourceError();
  }
}

/** Registers the built approval view as an MCP Apps HTML resource. */
export function registerApprovalResource(server: McpServer, html = loadApprovalHtml()): void {
  server.registerResource(
    "harness-approval",
    APPROVAL_RESOURCE_URI,
    {
      title: "Harness approval",
      mimeType: MCP_APP_HTML_MIME_TYPE,
      _meta: { ui: { csp: {}, permissions: {} } },
    },
    (uri) => ({
      contents: [{ uri: uri.href, mimeType: MCP_APP_HTML_MIME_TYPE, text: html }],
    }),
  );
}
