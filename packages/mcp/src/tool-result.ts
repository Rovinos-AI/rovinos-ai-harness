// SPDX-License-Identifier: Apache-2.0
import { JsonValue, type JsonValue as JsonValueType } from "@harness/schemas";
import type { CallToolResult } from "@modelcontextprotocol/client";

const SMALL_BINARY_BYTES = 8_192;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function binaryBytes(value: unknown): Uint8Array | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  try {
    return Buffer.from(value, "base64");
  } catch {
    return undefined;
  }
}

interface ResourceBytes {
  readonly bytes?: Uint8Array;
  readonly data?: string;
  readonly mimeType: string;
}

function resourceBytes(block: Record<string, unknown>): ResourceBytes {
  const resource = block.resource;
  if (!isRecord(resource)) {
    return { mimeType: "application/octet-stream" };
  }
  const mimeType =
    typeof resource.mimeType === "string" ? resource.mimeType : "application/octet-stream";
  if (typeof resource.text === "string") {
    return { bytes: new TextEncoder().encode(resource.text), data: resource.text, mimeType };
  }
  const bytes = binaryBytes(resource.blob);
  return {
    ...(bytes === undefined ? {} : { bytes }),
    ...(typeof resource.blob === "string" ? { data: resource.blob } : {}),
    mimeType,
  };
}

interface NormalizedBlock {
  readonly block: JsonValueType;
  readonly offloadBlock: JsonValueType;
  readonly hasLargeBinary: boolean;
  readonly binaryPayload?: Uint8Array;
}

function isGenuineBinary(block: Record<string, unknown>, isResource: boolean): boolean {
  if (!isResource) {
    return block.type === "image" || block.type === "audio" || block.type === "blob";
  }
  return (
    isRecord(block.resource) &&
    typeof block.resource.blob === "string" &&
    typeof block.resource.text !== "string"
  );
}

function blockBytes(
  block: Record<string, unknown>,
  isResource: boolean,
  resource: ResourceBytes | undefined,
  genuineBinary: boolean,
): Uint8Array | undefined {
  if (isResource) {
    return resource?.bytes;
  }
  return genuineBinary ? binaryBytes(block.data) : undefined;
}

function blockMimeType(
  block: Record<string, unknown>,
  isResource: boolean,
  resource: ResourceBytes | undefined,
): string {
  if (isResource) {
    return resource?.mimeType ?? "application/octet-stream";
  }
  return typeof block.mimeType === "string" ? block.mimeType : "application/octet-stream";
}

function blockData(
  block: Record<string, unknown>,
  isResource: boolean,
  resource: ResourceBytes | undefined,
): string | undefined {
  const value = isResource ? resource?.data : block.data;
  return typeof value === "string" ? value : undefined;
}

function visibleBlock(
  metadata: { readonly type: string; readonly mimeType: string; readonly bytes: number },
  data: string | undefined,
  hasLargeBinary: boolean,
): JsonValueType {
  if (data === undefined || hasLargeBinary) {
    return metadata;
  }
  return { ...metadata, data };
}

function normalizeBlock(block: unknown): NormalizedBlock {
  if (!isRecord(block) || typeof block.type !== "string") {
    return {
      block: { type: "unknown" },
      offloadBlock: { type: "unknown" },
      hasLargeBinary: false,
    };
  }
  if (block.type === "text" && typeof block.text === "string") {
    const textBlock = { type: "text", text: block.text };
    return { block: textBlock, offloadBlock: textBlock, hasLargeBinary: false };
  }
  const isResource = block.type === "resource";
  const resource = isResource ? resourceBytes(block) : undefined;
  const genuineBinary = isGenuineBinary(block, isResource);
  const bytes = blockBytes(block, isResource, resource, genuineBinary);
  const mimeType = blockMimeType(block, isResource, resource);
  const byteCount = bytes?.byteLength ?? 0;
  const hasLargeBinary = genuineBinary && byteCount > SMALL_BINARY_BYTES;
  const type = block.type;
  const metadata = { type, mimeType, bytes: byteCount };
  const data = blockData(block, isResource, resource);
  const visible = visibleBlock(metadata, data, hasLargeBinary);
  const offloadBlock = data === undefined ? metadata : { ...metadata, data };
  return {
    block: visible,
    offloadBlock,
    hasLargeBinary,
    ...(hasLargeBinary && bytes !== undefined ? { binaryPayload: bytes } : {}),
  };
}

/** Normalizes an MCP result into safe JSON and its optional binary offload payload. */
export function normalizedResult(result: CallToolResult): {
  readonly value: JsonValueType;
  readonly offloadValue: JsonValueType;
  readonly hasLargeBinary: boolean;
  readonly binaryPayload?: Uint8Array;
} {
  const blocks = result.content.map(normalizeBlock);
  const content = blocks.map(({ block }) => block);
  const offloadContent = blocks.map(({ offloadBlock }) => offloadBlock);
  const structuredContent: unknown = Reflect.get(result, "structuredContent");
  const value = JsonValue.parse({
    content,
    ...(structuredContent === undefined ? {} : { structured: structuredContent }),
  });
  const offloadValue = JsonValue.parse({
    content: offloadContent,
    ...(structuredContent === undefined ? {} : { structured: structuredContent }),
  });
  const largeBinaryBlock = blocks.find(({ hasLargeBinary }) => hasLargeBinary);
  return {
    value,
    offloadValue,
    hasLargeBinary: blocks.some(({ hasLargeBinary }) => hasLargeBinary),
    ...(largeBinaryBlock?.binaryPayload === undefined
      ? {}
      : { binaryPayload: largeBinaryBlock.binaryPayload }),
  };
}
