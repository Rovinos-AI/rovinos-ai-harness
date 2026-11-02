// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import type { ModelRequest } from "@rovinos/schemas";
import { ProviderError } from "../errors.js";

const PROVIDER_TOOL_NAME = /^[\w-]{1,64}$/u;
const ALIAS_PREFIX = "T_";
const ALIAS_HASH_LENGTH = 62;

/** Request-local translation between canonical tool IDs and provider-safe names. */
export interface ProviderToolAliases {
  /** Resolves a canonical tool ID available in this request to its provider alias. */
  toProviderName(toolId: string): string;
  /** Resolves an advertised canonical tool ID to its provider alias. */
  toAdvertisedProviderName(toolId: string): string;
  /** Resolves a provider alias returned for an advertised tool to its canonical ID. */
  toCanonicalName(name: string): string;
  /** Maps a canonical or previously aliased tool name found in provider history. */
  providerNameForHistory(name: string): string;
}

function providerAlias(toolId: string): string {
  const digest = createHash("sha256").update(toolId, "utf8").digest("hex");
  return `${ALIAS_PREFIX}${digest.slice(0, ALIAS_HASH_LENGTH)}`;
}

function invalidToolName(): ProviderError {
  return new ProviderError("provider_bad_request");
}

/**
 * Creates deterministic provider aliases for advertised and historical canonical IDs.
 *
 * Aliases use the provider-safe ASCII alphabet and stay within the 64-character name limit. The
 * uppercase prefix keeps them outside the harness's lowercase `Code` namespace, and alias
 * collisions fail closed rather than routing a call ambiguously.
 *
 * @param advertisedToolIds - Canonical IDs whose returned aliases may be decoded.
 * @param historyToolIds - Additional canonical IDs used only to translate request history.
 * @returns A request-scoped bidirectional alias map.
 */
export function createProviderToolAliases(
  advertisedToolIds: readonly string[],
  historyToolIds: readonly string[] = [],
): ProviderToolAliases {
  const advertised = new Set(advertisedToolIds);
  if (advertised.size !== advertisedToolIds.length) {
    throw invalidToolName();
  }

  const toolIds = new Set([...advertisedToolIds, ...historyToolIds]);
  const providerNameByToolId = new Map<string, string>();
  const toolIdByProviderName = new Map<string, string>();
  for (const toolId of toolIds) {
    const alias = providerAlias(toolId);
    if (!PROVIDER_TOOL_NAME.test(alias) || toolIdByProviderName.has(alias) || toolIds.has(alias)) {
      throw invalidToolName();
    }
    providerNameByToolId.set(toolId, alias);
    toolIdByProviderName.set(alias, toolId);
  }

  return {
    toProviderName(toolId) {
      const alias = providerNameByToolId.get(toolId);
      if (alias === undefined) {
        throw invalidToolName();
      }
      return alias;
    },
    toAdvertisedProviderName(toolId) {
      if (!advertised.has(toolId)) {
        throw invalidToolName();
      }
      const alias = providerNameByToolId.get(toolId);
      if (alias === undefined) {
        throw invalidToolName();
      }
      return alias;
    },
    toCanonicalName(name) {
      const toolId = toolIdByProviderName.get(name);
      if (toolId === undefined || !advertised.has(toolId)) {
        throw invalidToolName();
      }
      return toolId;
    },
    providerNameForHistory(name) {
      if (toolIdByProviderName.has(name)) {
        return name;
      }
      const alias = providerNameByToolId.get(name);
      if (alias === undefined) {
        throw invalidToolName();
      }
      return alias;
    },
  };
}

/** Creates the provider alias map for tool declarations and canonical tool calls in history. */
export function createProviderToolAliasesForRequest(request: ModelRequest): ProviderToolAliases {
  const historyToolIds = request.messages.flatMap((message) =>
    message.parts.flatMap((part) => (part.type === "tool_call" ? [part.toolId] : [])),
  );
  return createProviderToolAliases(
    request.toolChoice === "none" ? [] : (request.tools?.map((tool) => tool.toolId) ?? []),
    historyToolIds,
  );
}
