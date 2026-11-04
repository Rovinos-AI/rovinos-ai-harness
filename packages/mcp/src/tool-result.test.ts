// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { McpToolResultError, normalizedResult } from "./tool-result.js";

const allowBinary = { binaryResults: "allow", maxArtifactBytes: 16 } as const;

// Model malformed server payloads at the boundary without weakening the SDK's types.
function serverResult(content: readonly unknown[]): CallToolResult {
  const result: CallToolResult = { content: [] };
  Reflect.set(result, "content", content);
  return result;
}

describe("MCP result normalization", () => {
  it.each([
    null,
    [],
    {},
    { type: 1 },
    { type: "unknown" },
    { type: "image", data: 1 },
    { type: "resource", resource: null },
    { type: "resource", resource: [] },
    { type: "resource", resource: {} },
    { type: "resource", resource: { blob: "YQ==", text: "ambiguous" } },
    { type: "resource", resource: { text: 1 } },
    { type: "text", text: "synthetic", extra: () => undefined },
  ])("rejects malformed or non-JSON content: %j", (part) => {
    expect(() => normalizedResult(serverResult([part]), allowBinary)).toThrow(
      new McpToolResultError("mcp_result_invalid"),
    );
  });

  it.each(["YQ", "!!!!", "YQ==\n", "YR==", "YWJ="])(
    "rejects malformed base64 or encodings with nonzero padding bits: %j",
    (data) => {
      expect(() => normalizedResult(serverResult([{ type: "blob", data }]), allowBinary)).toThrow(
        new McpToolResultError("mcp_result_invalid"),
      );
    },
  );

  it.each(["a", "ab", "abc"])("offloads binary data with every padding length for %s", (text) => {
    const bytes = Buffer.from(text);
    const part = { type: "blob", data: bytes.toString("base64") };
    const result = normalizedResult(serverResult([part]), {
      ...allowBinary,
      maxArtifactBytes: bytes.byteLength,
    });

    expect(result.value.parts).toEqual([{ type: "blob" }]);
    expect(result.artifacts).toEqual([
      {
        partIndex: 0,
        target: "data",
        mimeType: "application/octet-stream",
        bytes,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    ]);
    expect(part.data).toBe(bytes.toString("base64"));
  });

  it("strips only embedded binary bytes and preserves resource order and the input", () => {
    const content = [
      { type: "resource", resource: { uri: "file:///synthetic/text", text: "before" } },
      { type: "resource", resource: { uri: "file:///synthetic/blob", blob: "YQ==" } },
      {
        type: "resource",
        resource: { uri: "file:///synthetic/typed", blob: "YWI=", mimeType: "image/png" },
      },
    ];
    const result = normalizedResult(serverResult(content), allowBinary);

    expect(result.value.parts).toEqual([
      content[0],
      { type: "resource", resource: { uri: "file:///synthetic/blob" } },
      { type: "resource", resource: { uri: "file:///synthetic/typed", mimeType: "image/png" } },
    ]);
    expect(result.artifacts).toMatchObject([
      {
        partIndex: 1,
        target: "resource.blob",
        mimeType: "application/octet-stream",
        bytes: Buffer.from("a"),
      },
      {
        partIndex: 2,
        target: "resource.blob",
        mimeType: "image/png",
        bytes: Buffer.from("ab"),
      },
    ]);
    expect(content[1]?.resource.blob).toBe("YQ==");
    expect(content[2]?.resource.blob).toBe("YWI=");
  });

  it("converts invalid envelope metadata to a closed result error", () => {
    const result: CallToolResult = { content: [] };
    Reflect.set(result, "_meta", { unsupported: () => undefined });
    expect(() => normalizedResult(result, allowBinary)).toThrow(
      new McpToolResultError("mcp_result_invalid"),
    );
  });
});
