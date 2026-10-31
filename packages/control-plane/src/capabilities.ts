// SPDX-License-Identifier: Apache-2.0
import type { Tool } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ConfirmationClientCapabilities } from "./confirmation-gate.js";

const MCP_APP_EXTENSION = "io.modelcontextprotocol/ui";
const MCP_APP_MIME = "text/html;profile=mcp-app";

/** Returns whether the client advertises the MCP Apps HTML extension. */
export function supportsMcpApps(capabilities: ConfirmationClientCapabilities | undefined): boolean {
  const extension = z
    .object({ mimeTypes: z.array(z.string()) })
    .loose()
    .safeParse(capabilities?.extensions?.[MCP_APP_EXTENSION]);
  return extension.success && extension.data.mimeTypes.includes(MCP_APP_MIME);
}

/** Filters app-only tools from clients that did not advertise MCP Apps support. */
export function filterToolsForClient<T extends Tool>(
  tools: readonly T[],
  capabilities: ConfirmationClientCapabilities | undefined,
): T[] {
  if (supportsMcpApps(capabilities)) {
    return [...tools];
  }
  return tools.filter((tool) => !isAppOnlyTool(tool));
}

function isAppOnlyTool(tool: Tool): boolean {
  if (
    tool.name.startsWith("harness.approvals.") ||
    tool.name.startsWith("harness.inputs.") ||
    tool.name === "harness.runs.list" ||
    tool.name === "harness.runs.get"
  ) {
    return true;
  }
  const metadata = z
    .looseObject({
      ui: z.looseObject({ visibility: z.array(z.string()).optional() }),
    })
    .safeParse(tool._meta);
  return metadata.success && metadata.data.ui.visibility?.includes("app") === true;
}
