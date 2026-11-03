// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import type { ModelRequest } from "@rovinos/schemas";
import { ProviderError } from "../errors.js";

const PROVIDER_TOOL_NAME = /^[\w-]{1,64}$/u;
const MAX_TOOL_NAME_LENGTH = 64;
const HASH_SUFFIX_LENGTH = 9;
const HASH_LENGTH = HASH_SUFFIX_LENGTH - 1;

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
  const suffix = createHash("sha256").update(toolId, "utf8").digest("hex").slice(0, HASH_LENGTH);
  return `_${suffix}`;
}

function sanitizedToolName(toolId: string): string {
  const name = toolId.replaceAll(/[^\w-]+/gu, "_");
  return name.length === 0 ? "tool" : name;
}

function invalidToolName(): ProviderError {
  return new ProviderError("provider_bad_request");
}

function uniqueProviderNames(toolIds: readonly string[]): Map<string, string> {
  const sanitizedNames = new Map(toolIds.map((toolId) => [toolId, sanitizedToolName(toolId)]));
  const countsByName = new Map<string, number>();
  for (const name of sanitizedNames.values()) {
    countsByName.set(name, (countsByName.get(name) ?? 0) + 1);
  }
  const needsHash = new Set(
    toolIds.filter(
      (toolId) =>
        (sanitizedNames.get(toolId)?.length ?? 0) > MAX_TOOL_NAME_LENGTH ||
        (countsByName.get(sanitizedNames.get(toolId) ?? "") ?? 0) > 1,
    ),
  );
  for (let attempt = 0; attempt <= toolIds.length; attempt += 1) {
    const namesByToolId = new Map(
      toolIds.map((toolId) => {
        const name = sanitizedNames.get(toolId) ?? "tool";
        const providerName = needsHash.has(toolId)
          ? `${name.slice(0, MAX_TOOL_NAME_LENGTH - HASH_SUFFIX_LENGTH)}${providerAlias(toolId)}`
          : name;
        return [toolId, providerName];
      }),
    );
    const toolIdsByName = new Map<string, string[]>();
    for (const [toolId, name] of namesByToolId) {
      const collidingIds = toolIdsByName.get(name) ?? [];
      collidingIds.push(toolId);
      toolIdsByName.set(name, collidingIds);
    }
    const collisions = [...toolIdsByName.values()].filter((ids) => ids.length > 1);
    if (collisions.length === 0) {
      return namesByToolId;
    }
    let updated = false;
    for (const ids of collisions) {
      for (const toolId of ids) {
        if (!needsHash.has(toolId)) {
          needsHash.add(toolId);
          updated = true;
        }
      }
    }
    if (!updated) {
      throw invalidToolName();
    }
  }
  throw invalidToolName();
}

/**
 * Creates deterministic provider aliases for advertised and historical canonical IDs.
 *
 * Aliases retain readable canonical-name characters, replace unsupported characters with
 * underscores, and use a short digest only for request-local collisions or long names.
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

  const toolIds = [...new Set([...advertisedToolIds, ...historyToolIds])];
  const namesByToolId = uniqueProviderNames(toolIds);
  const providerNameByToolId = new Map<string, string>();
  const toolIdByProviderName = new Map<string, string>();
  for (const [toolId, alias] of namesByToolId) {
    if (!PROVIDER_TOOL_NAME.test(alias)) {
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
