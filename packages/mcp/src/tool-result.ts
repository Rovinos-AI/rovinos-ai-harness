// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import {
  JsonValue,
  McpToolResultEnvelopeSchema,
  Sha256Hex,
  type JsonValue as JsonValueType,
  type McpToolResultEnvelope,
} from "@rovinos/schemas";
import type { CallToolResult } from "@modelcontextprotocol/client";

export interface McpResultArtifactPayload {
  readonly partIndex: number;
  readonly target: "data" | "resource.blob";
  readonly mimeType: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

export class McpToolResultError extends Error {
  constructor(readonly code: "mcp_binary_result_blocked" | "mcp_result_invalid" | "artifact_too_large") {
    super(code);
  }
}

interface BinarySource {
  readonly partIndex: number;
  readonly target: McpResultArtifactPayload["target"];
  readonly mimeType: string;
  readonly encoded: string;
  readonly decodedBytes: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function binaryMimeType(block: Record<string, unknown>): string {
  return typeof block.mimeType === "string" ? block.mimeType : "application/octet-stream";
}

function decodedBase64Length(encoded: string): number {
  if (
    encoded.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)
  ) {
    throw new McpToolResultError("mcp_result_invalid");
  }
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  return (encoded.length / 4) * 3 - padding;
}

function findBinarySources(
  content: readonly unknown[],
  maxArtifactBytes: number,
  binaryResults: "block" | "allow",
): BinarySource[] {
  const sources: BinarySource[] = [];
  let totalBytes = 0;
  for (const [partIndex, part] of content.entries()) {
    if (!isRecord(part) || typeof part.type !== "string") {
      throw new McpToolResultError("mcp_result_invalid");
    }
    let target: BinarySource["target"] | undefined;
    let mimeType = binaryMimeType(part);
    let encoded: unknown;
    if (["image", "audio", "blob"].includes(part.type)) {
      target = "data";
      encoded = part.data;
    } else if (part.type === "resource" && isRecord(part.resource)) {
      const resource = part.resource;
      if (typeof resource.blob === "string" && typeof resource.text !== "string") {
        target = "resource.blob";
        encoded = resource.blob;
        mimeType =
          typeof resource.mimeType === "string" ? resource.mimeType : "application/octet-stream";
      } else if (resource.blob !== undefined || resource.text !== undefined) {
        if (typeof resource.text !== "string" || resource.blob !== undefined) {
          throw new McpToolResultError("mcp_result_invalid");
        }
      } else {
        throw new McpToolResultError("mcp_result_invalid");
      }
    } else if (!["text", "resource", "resource_link"].includes(part.type)) {
      throw new McpToolResultError("mcp_result_invalid");
    }
    if (target === undefined) {
      continue;
    }
    if (binaryResults !== "allow") {
      throw new McpToolResultError("mcp_binary_result_blocked");
    }
    if (typeof encoded !== "string") {
      throw new McpToolResultError("mcp_result_invalid");
    }
    const decodedBytes = decodedBase64Length(encoded);
    totalBytes += decodedBytes;
    if (totalBytes > maxArtifactBytes) {
      throw new McpToolResultError("artifact_too_large");
    }
    sources.push({ partIndex, target, mimeType, encoded, decodedBytes });
  }
  return sources;
}

function normalizedParts(
  content: readonly unknown[],
  sources: readonly BinarySource[],
): JsonValueType[] {
  const binaryParts = new Map(
    sources.map((source) => [`${source.partIndex}:${source.target}`, source.partIndex]),
  );
  return content.map((part, partIndex) => {
    if (!isRecord(part)) {
      throw new McpToolResultError("mcp_result_invalid");
    }
    const copy = { ...part };
    if (binaryParts.has(`${partIndex}:data`)) {
      Reflect.deleteProperty(copy, "data");
    }
    if (binaryParts.has(`${partIndex}:resource.blob`)) {
      if (!isRecord(copy.resource)) {
        throw new McpToolResultError("mcp_result_invalid");
      }
      const resource = { ...copy.resource };
      Reflect.deleteProperty(resource, "blob");
      copy.resource = resource;
    }
    try {
      return JsonValue.parse(copy);
    } catch {
      throw new McpToolResultError("mcp_result_invalid");
    }
  });
}

/** Preserves the ordered MCP result while moving binary bytes to an internal artifact side channel. */
export function normalizedResult(
  result: CallToolResult,
  options: {
    readonly maxArtifactBytes: number;
    readonly binaryResults: "block" | "allow";
  },
): {
  readonly value: McpToolResultEnvelope;
  readonly artifacts: readonly McpResultArtifactPayload[];
} {
  const content: readonly unknown[] = result.content;
  const sources = findBinarySources(content, options.maxArtifactBytes, options.binaryResults);
  const artifacts = sources.map((source) => {
    const bytes = Buffer.from(source.encoded, "base64");
    if (bytes.byteLength !== source.decodedBytes || bytes.toString("base64") !== source.encoded) {
      throw new McpToolResultError("mcp_result_invalid");
    }
    return {
      partIndex: source.partIndex,
      target: source.target,
      mimeType: source.mimeType,
      bytes,
      sha256: Sha256Hex.parse(createHash("sha256").update(bytes).digest("hex")),
    };
  });
  const structuredContent: unknown = Reflect.get(result, "structuredContent");
  const metadata: unknown = Reflect.get(result, "_meta");
  try {
    return {
      value: McpToolResultEnvelopeSchema.parse({
        format: "mcp-tool-result",
        version: 1,
        isError: result.isError === true,
        parts: normalizedParts(content, sources),
        ...(structuredContent === undefined ? {} : { structuredContent }),
        ...(metadata === undefined ? {} : { metadata }),
      }),
      artifacts,
    };
  } catch {
    throw new McpToolResultError("mcp_result_invalid");
  }
}
