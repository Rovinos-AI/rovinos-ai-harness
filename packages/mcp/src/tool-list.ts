// SPDX-License-Identifier: Apache-2.0
// Raw tools/list paging: the SDK's listTools() logs server-provided tool names via console.warn.
import type { ListToolsResult } from "@modelcontextprotocol/client";
import { McpConnectionError } from "./errors.js";
import { abortable, decodedBytes } from "./discovery-budget.js";
import { McpAuthRequiredError } from "./oauth/provider.js";

/** MCP tools discovered from a server. */
export type McpTool = ListToolsResult["tools"][number];

const MAX_TOOLS = 1_000;
const MAX_PAGES = 100;
const MAX_SCHEMA_BYTES = 1_048_576;
const MAX_DECODED_BYTES = 8_388_608;
const DISCOVERY_TIMEOUT_MS = 30_000;
const MAX_CONCURRENT_DISCOVERIES = 4;
let activeDiscoveries = 0;
const MAX_HEADER_SCAN_DEPTH = 32;
const RESERVED_HEADER_NAMES = new Set(["traceparent", "tracestate", "baggage"]);
const HEADER_TOKEN = /^[!#$%&'*+.^`|~\w-]+$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasInvalidHeaderDeclaration(
  schema: ReadonlyMap<string, unknown>,
  reachable: boolean,
  seen: Set<string>,
): boolean {
  if (!schema.has("x-mcp-header")) {
    return false;
  }
  const header = schema.get("x-mcp-header");
  const type = schema.get("type");
  if (
    !reachable ||
    typeof header !== "string" ||
    !HEADER_TOKEN.test(header) ||
    RESERVED_HEADER_NAMES.has(header.toLowerCase()) ||
    !["string", "integer", "boolean"].includes(String(type)) ||
    seen.has(header.toLowerCase())
  ) {
    return true;
  }
  seen.add(header.toLowerCase());
  return false;
}

function hasInvalidNestedHeaders(
  entries: readonly [string, unknown][],
  depth: number,
  seen: Set<string>,
  reachable: boolean,
): boolean {
  for (const [key, value] of entries) {
    if (key === "x-mcp-header") {
      continue;
    }
    if (key === "properties") {
      if (!isRecord(value) && !Array.isArray(value)) {
        continue;
      }
      const properties = Array.isArray(value) ? value : Object.values(value);
      if (
        properties.some((property) => hasInvalidMcpHeader(property, depth + 1, seen, reachable))
      ) {
        return true;
      }
    } else if (isRecord(value) || Array.isArray(value)) {
      if (hasInvalidMcpHeader(value, depth + 1, seen, false)) {
        return true;
      }
    }
  }
  return false;
}

function hasInvalidMcpHeader(
  value: unknown,
  depth = 0,
  seen = new Set<string>(),
  reachable = true,
): boolean {
  if (depth > MAX_HEADER_SCAN_DEPTH) {
    return true;
  }
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((item) => hasInvalidMcpHeader(item, depth + 1, seen, false));
  }
  const entries = Object.entries(value);
  const schema = new Map(entries);
  return (
    hasInvalidHeaderDeclaration(schema, reachable, seen) ||
    hasInvalidNestedHeaders(entries, depth, seen, reachable)
  );
}

/**
 * Retains valid SEP-2243 `x-mcp-header` declarations on modern Streamable HTTP.
 *
 * The raw `tools/list` path bypasses the SDK's exclusion (which logs the server-provided tool
 * name through `console.warn`), so invalid declarations and overly deep schemas are excluded
 * here. Valid argument declarations are passed to the SDK for request-header mapping. Returns
 * the kept tools and the number excluded so callers can log a count, never a name.
 */
export function excludeHeaderDeclaringTools(
  tools: readonly McpTool[],
  options: { readonly era: "legacy" | "modern" | undefined; readonly transport: "stdio" | "http" },
): { readonly tools: McpTool[]; readonly excluded: number } {
  if (options.era !== "modern" || options.transport !== "http") {
    return { tools: [...tools], excluded: 0 };
  }
  const kept = tools.filter((tool) => !hasInvalidMcpHeader(tool.inputSchema));
  return { tools: kept, excluded: tools.length - kept.length };
}

/** Options for paging through a server's `tools/list` results. */
export interface ListAllToolsOptions {
  /** Requests one schema-validated page. */
  readonly requestPage: (
    cursor: string | undefined,
    signal: AbortSignal,
  ) => Promise<ListToolsResult>;
  /** Cancels the complete discovery, including the outstanding page request. */
  readonly signal?: AbortSignal;
  /** Clock for operation-wide deadline checks during decoded-data work. */
  readonly now?: () => number;
  /** Negotiated era and transport, which decide `x-mcp-header` exclusion. */
  readonly era: "legacy" | "modern" | undefined;
  readonly transport: "stdio" | "http";
  /** Receives the number of tools excluded from one page. */
  readonly onExcluded: (count: number) => void;
}

function nextCursor(page: ListToolsResult, seen: Set<string>): string | undefined {
  if (page.nextCursor === undefined || page.nextCursor === "") {
    return undefined;
  }
  if (seen.has(page.nextCursor)) {
    throw new McpConnectionError("mcp_list_tools_failed");
  }
  seen.add(page.nextCursor);
  return page.nextCursor;
}

/**
 * Follows even empty pages under operation-wide work and decoded-data budgets.
 * Fails closed on truncation; only a complete result may be cached or registered.
 */
export async function listAllTools(
  options: ListAllToolsOptions,
): Promise<{ readonly tools: McpTool[]; readonly ttlMs: number | undefined }> {
  if (options.signal?.aborted === true) {
    throw new McpConnectionError("mcp_discovery_cancelled");
  }
  if (activeDiscoveries >= MAX_CONCURRENT_DISCOVERIES) {
    throw new McpConnectionError("mcp_discovery_busy");
  }
  activeDiscoveries++;
  const deadline = new AbortController();
  const timer = setTimeout(() => {
    deadline.abort();
  }, DISCOVERY_TIMEOUT_MS);
  const signal = AbortSignal.any([
    deadline.signal,
    ...(options.signal === undefined ? [] : [options.signal]),
  ]);
  const now = options.now ?? Date.now;
  const expiresAt = now() + DISCOVERY_TIMEOUT_MS;
  const assertActive = () => {
    if (now() >= expiresAt) {
      deadline.abort();
    }
    if (signal.aborted) {
      throw new McpConnectionError("mcp_discovery_cancelled");
    }
  };
  try {
    return await collectTools(options, signal, assertActive);
  } catch (error) {
    if (signal.aborted) {
      throw new McpConnectionError(
        deadline.signal.aborted ? "mcp_discovery_timeout" : "mcp_discovery_cancelled",
      );
    }
    if (error instanceof McpAuthRequiredError) {
      throw error;
    }
    throw error instanceof McpConnectionError
      ? error
      : new McpConnectionError("mcp_list_tools_failed");
  } finally {
    clearTimeout(timer);
    activeDiscoveries--;
  }
}

async function collectTools(
  options: ListAllToolsOptions,
  signal: AbortSignal,
  assertActive: () => void,
): Promise<{ readonly tools: McpTool[]; readonly ttlMs: number | undefined }> {
  const tools: McpTool[] = [];
  const seen = new Set<string>();
  let pages = 0;
  let observed = 0;
  let bytes = 0;
  let ttlMs: number | undefined;
  let cursor: string | undefined;
  do {
    assertActive();
    if (pages >= MAX_PAGES) {
      throw new McpConnectionError("mcp_discovery_page_limit");
    }
    const page = await abortable(() => options.requestPage(cursor, signal), signal);
    pages++;
    observed += page.tools.length;
    if (observed > MAX_TOOLS) {
      throw new McpConnectionError("mcp_too_many_tools");
    }
    bytes += decodedBytes(page, MAX_DECODED_BYTES - bytes, "mcp_discovery_data_limit", signal);
    for (const tool of page.tools) {
      decodedBytes(tool.inputSchema, MAX_SCHEMA_BYTES, "mcp_discovery_schema_limit", signal);
      if (tool.outputSchema !== undefined) {
        decodedBytes(tool.outputSchema, MAX_SCHEMA_BYTES, "mcp_discovery_schema_limit", signal);
      }
    }
    if (ttlMs === undefined && "ttlMs" in page && typeof page.ttlMs === "number") {
      ttlMs = page.ttlMs;
    }
    const filtered = excludeHeaderDeclaringTools(page.tools, options);
    if (filtered.excluded > 0) {
      options.onExcluded(filtered.excluded);
    }
    tools.push(...filtered.tools);
    cursor = nextCursor(page, seen);
    assertActive();
  } while (cursor !== undefined);
  return { tools, ttlMs };
}
