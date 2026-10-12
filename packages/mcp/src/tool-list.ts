// SPDX-License-Identifier: Apache-2.0
// Raw tools/list paging: the SDK's listTools() logs server-provided tool names via console.warn.
import type { ListToolsResult } from "@modelcontextprotocol/client";
import { McpConnectionError } from "./errors.js";

/** MCP tools discovered from a server. */
export type McpTool = ListToolsResult["tools"][number];

const MAX_TOOLS = 1_000;
const MAX_HEADER_SCAN_DEPTH = 32;

function declaresMcpHeader(value: unknown, depth = 0): boolean {
  if (typeof value !== "object" || value === null || depth > MAX_HEADER_SCAN_DEPTH) {
    return depth > MAX_HEADER_SCAN_DEPTH;
  }
  if (Array.isArray(value)) {
    return value.some((item) => declaresMcpHeader(item, depth + 1));
  }
  return Object.entries(value).some(
    ([key, item]) => key === "x-mcp-header" || declaresMcpHeader(item, depth + 1),
  );
}

/**
 * Drops tools that declare SEP-2243 `x-mcp-header` parameters on modern Streamable HTTP.
 *
 * The raw `tools/list` path bypasses the SDK's exclusion (which logs the server-provided tool
 * name through `console.warn`), so this conservatively excludes every declaring tool instead
 * of only invalid ones; overly deep schemas are excluded too. Returns the kept tools and the
 * number excluded so callers can log a count, never a name.
 */
export function excludeHeaderDeclaringTools(
  tools: readonly McpTool[],
  options: { readonly era: "legacy" | "modern" | undefined; readonly transport: "stdio" | "http" },
): { readonly tools: McpTool[]; readonly excluded: number } {
  if (options.era !== "modern" || options.transport !== "http") {
    return { tools: [...tools], excluded: 0 };
  }
  const kept = tools.filter((tool) => !declaresMcpHeader(tool.inputSchema));
  return { tools: kept, excluded: tools.length - kept.length };
}

/** Options for paging through a server's `tools/list` results. */
export interface ListAllToolsOptions {
  /** Requests one schema-validated page. */
  readonly requestPage: (cursor: string | undefined) => Promise<ListToolsResult>;
  /** Negotiated era and transport, which decide `x-mcp-header` exclusion. */
  readonly era: "legacy" | "modern" | undefined;
  readonly transport: "stdio" | "http";
  /** Receives the number of tools excluded from one page. */
  readonly onExcluded: (count: number) => void;
}

function nextCursor(page: ListToolsResult, seen: Set<string>): string | undefined {
  if (page.nextCursor === undefined || page.nextCursor === "" || page.tools.length === 0) {
    return undefined;
  }
  if (seen.has(page.nextCursor)) {
    throw new McpConnectionError("mcp_list_tools_failed");
  }
  seen.add(page.nextCursor);
  return page.nextCursor;
}

/**
 * Follows `tools/list` cursors, stopping as soon as the 1,000-tool cap is exceeded or a cursor
 * repeats. Returns the tools and the first page's `ttlMs`, if any.
 */
export async function listAllTools(
  options: ListAllToolsOptions,
): Promise<{ readonly tools: McpTool[]; readonly ttlMs: number | undefined }> {
  const tools: McpTool[] = [];
  const seen = new Set<string>();
  let ttlMs: number | undefined;
  let cursor: string | undefined;
  do {
    const page = await options.requestPage(cursor);
    if (ttlMs === undefined && "ttlMs" in page && typeof page.ttlMs === "number") {
      ttlMs = page.ttlMs;
    }
    const filtered = excludeHeaderDeclaringTools(page.tools, options);
    if (filtered.excluded > 0) {
      options.onExcluded(filtered.excluded);
    }
    for (const tool of filtered.tools) {
      tools.push(tool);
      if (tools.length > MAX_TOOLS) {
        throw new McpConnectionError("mcp_too_many_tools");
      }
    }
    cursor = nextCursor(page, seen);
  } while (cursor !== undefined);
  return { tools, ttlMs };
}
