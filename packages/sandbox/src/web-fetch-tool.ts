// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import {
  JsonValue,
  ToolSpecSchema,
  type Code,
  type Id,
  type JsonValue as JsonValueType,
  type ToolSpec,
  SandboxEgressAllowlistSchema,
} from "@harness/schemas";
import {
  MAX_WEB_FETCH_TIMEOUT_MS,
  WebFetchRequestSchema,
  WebFetchResultSchema,
} from "./web-fetch-contracts.js";
import type { WebFetchRequest, WebFetchResult } from "./web-fetch-contracts.js";

const WEB_FETCH_TOOL_ID: Code = "web.fetch";
const WEB_FETCH_TOOL_SPEC: ToolSpec = ToolSpecSchema.parse({
  toolId: WEB_FETCH_TOOL_ID,
  description: "Fetch allowlisted web content through the sandbox egress proxy.",
  inputSchema: JsonValue.parse(z.toJSONSchema(WebFetchRequestSchema)),
});

/** Runner-backed fetch function used by the built-in tool. */
export interface WebFetchBackend {
  /** Fetches one URL from the sandbox runner through its configured proxy. */
  fetch(runId: Id, request: WebFetchRequest, signal: AbortSignal): Promise<WebFetchResult>;
}

/** Options for the built-in `web.fetch` tool. */
export interface WebFetchToolOptions {
  readonly backend: WebFetchBackend;
}

interface WebFetchToolCall {
  readonly callId: Id;
  readonly toolId: Code;
  readonly args: JsonValueType;
}

interface WebFetchRunContext {
  readonly runId: Id;
  readonly signal: AbortSignal;
}

interface WebFetchToolExecution {
  readonly outcome: "ok" | "error";
  readonly result: JsonValueType;
  readonly errorCode?: Code;
}

/** Exposes runner-mediated, allowlisted web fetches as an idempotent built-in tool. */
export class WebFetchTool {
  readonly #backend: WebFetchBackend;

  /** Create the tool with a backend that implements the runner fetch endpoint. */
  constructor(options: WebFetchToolOptions) {
    this.#backend = options.backend;
  }

  /** Return retry metadata for this idempotent fetch tool. */
  describe(toolId: Code): { readonly idempotent: boolean; readonly timeoutMs: number } | undefined {
    return toolId === WEB_FETCH_TOOL_ID
      ? { idempotent: true, timeoutMs: MAX_WEB_FETCH_TIMEOUT_MS }
      : undefined;
  }

  /** Advertise the strict fetch input schema to model providers. */
  getToolSpecs(): readonly ToolSpec[] {
    return [WEB_FETCH_TOOL_SPEC];
  }

  /** Validate a request and return only the runner's untrusted response. */
  async execute(
    call: WebFetchToolCall,
    context: WebFetchRunContext,
  ): Promise<WebFetchToolExecution> {
    if (call.toolId !== WEB_FETCH_TOOL_ID) {
      return { outcome: "error", errorCode: "sandbox_fetch_unknown_tool", result: null };
    }
    const parsed = WebFetchRequestSchema.safeParse(call.args);
    if (!parsed.success) {
      return { outcome: "error", errorCode: "sandbox_fetch_invalid", result: null };
    }
    try {
      const result = WebFetchResultSchema.parse(
        await this.#backend.fetch(context.runId, parsed.data, context.signal),
      );
      return { outcome: "ok", result: JsonValue.parse(result) };
    } catch {
      return { outcome: "error", errorCode: "sandbox_fetch_failed", result: null };
    }
  }
}

/**
 * Registers `web.fetch` only when the runner has an explicit non-empty egress allowlist.
 *
 * @param allowlist - Validated sandbox egress destinations.
 * @param backend - Remote runner fetch backend.
 * @returns The built-in tool, or `undefined` when egress is disabled.
 */
export function createWebFetchTool(
  allowlist: unknown,
  backend: WebFetchBackend,
): WebFetchTool | undefined {
  const parsed = SandboxEgressAllowlistSchema.safeParse(allowlist);
  return parsed.success && parsed.data.length > 0 ? new WebFetchTool({ backend }) : undefined;
}
