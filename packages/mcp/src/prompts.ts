// SPDX-License-Identifier: Apache-2.0
import { McpPromptError, McpConnectionError } from "./errors.js";
import { abortable, decodedBytes } from "./discovery-budget.js";
import { z } from "zod";

const PromptArgumentSchema = z.looseObject({
  name: z.string(),
  description: z.string().optional(),
  required: z.boolean().optional(),
});

const PromptSchema = z.looseObject({
  name: z.string(),
  description: z.string().optional(),
  arguments: z.array(PromptArgumentSchema).optional(),
});

const PromptListEnvelopeSchema = z.looseObject({
  prompts: z.array(PromptSchema),
  nextCursor: z.string().optional(),
});

const PromptMessageSchema = z.looseObject({
  role: z.enum(["user", "assistant"]),
  content: z.unknown(),
});

const PromptResultEnvelopeSchema = z.looseObject({
  description: z.string().optional(),
  messages: z.array(PromptMessageSchema),
});

export const ListPromptsResultSchema = PromptListEnvelopeSchema;
export const GetPromptResultSchema = PromptResultEnvelopeSchema;
/** Validated prompt-list response. */
export type ListPromptsResult = z.infer<typeof ListPromptsResultSchema>;
/** One server-advertised MCP prompt. */
export type McpPrompt = ListPromptsResult["prompts"][number];
/** Validated prompt-get response. */
export type GetPromptResult = z.infer<typeof GetPromptResultSchema>;

const MAX_PROMPTS = 1_000;
const MAX_PAGES = 100;
const MAX_DECODED_BYTES = 8_388_608;
const DISCOVERY_TIMEOUT_MS = 30_000;
const MAX_CONCURRENT_DISCOVERIES = 4;
let activeDiscoveries = 0;
const waitingDiscoveries = new Set<() => void>();

/** Options for a bounded prompt-list traversal. */
export interface ListAllPromptsOptions {
  readonly requestPage: (
    cursor: string | undefined,
    signal: AbortSignal,
  ) => Promise<ListPromptsResult>;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
}

function acquireDiscovery(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new McpPromptError("mcp_prompt_failed"));
      return;
    }
    const start = () => {
      waitingDiscoveries.delete(start);
      signal?.removeEventListener("abort", onAbort);
      activeDiscoveries++;
      resolve();
    };
    const onAbort = () => {
      waitingDiscoveries.delete(start);
      signal?.removeEventListener("abort", onAbort);
      reject(new McpPromptError("mcp_prompt_failed"));
    };
    if (activeDiscoveries < MAX_CONCURRENT_DISCOVERIES) {
      start();
    } else {
      waitingDiscoveries.add(start);
      signal?.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function promptFailure(error: unknown): McpPromptError {
  return error instanceof McpConnectionError && error.code === "mcp_response_too_large"
    ? new McpPromptError("mcp_prompt_result_too_large")
    : new McpPromptError("mcp_prompt_failed");
}

/** Pages through a bounded prompt catalog without caching server-controlled metadata. */
export async function listAllPrompts(options: ListAllPromptsOptions): Promise<McpPrompt[]> {
  await acquireDiscovery(options.signal);
  try {
    return await runDiscovery(options);
  } catch (error) {
    if (error instanceof McpPromptError) {
      throw error;
    }
    throw promptFailure(error);
  } finally {
    activeDiscoveries--;
    waitingDiscoveries.values().next().value?.();
  }
}

async function runDiscovery(options: ListAllPromptsOptions): Promise<McpPrompt[]> {
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
      throw new McpPromptError("mcp_prompt_failed");
    }
  };
  try {
    const prompts: McpPrompt[] = [];
    const names = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    let bytes = 0;
    const cursors = new Set<string>();
    do {
      assertActive();
      if (pages >= MAX_PAGES) {
        throw new McpPromptError("mcp_prompt_result_too_large");
      }
      const page = await abortable(() => options.requestPage(cursor, signal), signal);
      pages++;
      if (page.prompts.length > MAX_PROMPTS - prompts.length) {
        throw new McpPromptError("mcp_prompt_result_too_large");
      }
      bytes += decodedBytes(page, MAX_DECODED_BYTES - bytes, "mcp_response_too_large", signal);
      for (const prompt of page.prompts) {
        if (names.has(prompt.name)) {
          throw new McpPromptError("mcp_prompt_failed");
        }
        names.add(prompt.name);
        prompts.push(prompt);
      }
      if (page.nextCursor === undefined || page.nextCursor === "") {
        cursor = undefined;
      } else {
        if (cursors.has(page.nextCursor)) {
          throw new McpPromptError("mcp_prompt_failed");
        }
        cursors.add(page.nextCursor);
        cursor = page.nextCursor;
      }
      assertActive();
    } while (cursor !== undefined);
    return prompts;
  } catch (error) {
    if (error instanceof McpPromptError) {
      throw error;
    }
    throw promptFailure(error);
  } finally {
    clearTimeout(timer);
  }
}
