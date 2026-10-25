// SPDX-License-Identifier: Apache-2.0
import { Id, JsonValue } from "@rovinos/schemas";
import { describe, expect, it, vi } from "vitest";
import { MAX_WEB_FETCH_TIMEOUT_MS } from "./web-fetch-contracts.js";
import { createWebFetchTool, WebFetchTool } from "./web-fetch-tool.js";
import type { WebFetchBackend } from "./web-fetch-tool.js";

const runId = Id.parse("00000000000000000000000002");
const callId = Id.parse("00000000000000000000000003");
const url = "https://docs.example.test/page?token=synthetic-canary";
const response = {
  url: "https://docs.example.test/page",
  status: 200,
  contentType: "text/plain",
  text: "untrusted <EMAIL_1>",
  truncated: false,
  untrusted: true as const,
  hiddenTextDropped: 0,
};

function makeCall(toolId: string, args: unknown) {
  return { callId, toolId, args: JsonValue.parse(args) };
}

describe("WebFetchTool", () => {
  it("does not register the tool when egress is disabled or malformed", () => {
    const backend = { fetch: vi.fn() } satisfies WebFetchBackend;
    expect(createWebFetchTool([], backend)).toBeUndefined();
    expect(createWebFetchTool("invalid", backend)).toBeUndefined();
    expect(
      createWebFetchTool([{ host: "docs.example.test", ports: [443] }], backend),
    ).toBeInstanceOf(WebFetchTool);
  });

  it("advertises a strict idempotent fetch tool", () => {
    const backend = { fetch: vi.fn() } satisfies WebFetchBackend;
    const tool = new WebFetchTool({ backend });

    expect(tool.getToolSpecs()[0]?.toolId).toBe("web.fetch");
    expect(tool.describe("web.fetch")).toEqual({
      idempotent: true,
      timeoutMs: MAX_WEB_FETCH_TIMEOUT_MS,
    });
    expect(tool.describe("other.tool")).toBeUndefined();
    expect(tool.getToolSpecs()[0]?.inputSchema).toBeDefined();
  });

  it("rejects binary content when no offloader is configured", async () => {
    const backend = {
      fetch: vi.fn().mockResolvedValue({
        url: "https://docs.example.test/image",
        status: 200,
        contentType: "image/png",
        binary: true,
        bytes: [0, 255],
        truncated: false,
        untrusted: true,
      }),
    } satisfies WebFetchBackend;
    const tool = new WebFetchTool({ backend });

    await expect(
      tool.execute(makeCall("web.fetch", { url }), {
        runId,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      outcome: "error",
      errorCode: "binary_result_unavailable",
      result: null,
    });
  });

  it("sends validated inputs to the runner and returns marked untrusted content", async () => {
    const backend = { fetch: vi.fn().mockResolvedValue(response) } satisfies WebFetchBackend;
    const tool = new WebFetchTool({ backend });
    const signal = new AbortController().signal;

    await expect(
      tool.execute(makeCall("web.fetch", { url, accept: "text/plain" }), { runId, signal }),
    ).resolves.toEqual({ outcome: "ok", result: response });
    expect(backend.fetch).toHaveBeenCalledWith(runId, { url, accept: "text/plain" }, signal);
  });

  it("adapts binary content to the preview-free offload contract with sanitized metadata", async () => {
    const backend = {
      fetch: vi.fn().mockResolvedValue({
        url: "https://docs.example.test/image?synthetic=canary",
        status: 200,
        contentType: "image/png",
        binary: true,
        bytes: [0, 255],
        truncated: false,
        untrusted: true,
      }),
    } satisfies WebFetchBackend;
    const tool = new WebFetchTool({ backend, offloadBinaryResults: true });

    await expect(
      tool.execute(makeCall("web.fetch", { url }), {
        runId,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      outcome: "ok",
      binary: true,
      result: [0, 255],
      metadata: {
        url: "https://docs.example.test/image",
        status: 200,
        contentType: "image/png",
        truncated: false,
        untrusted: true,
      },
    });
  });

  it("rejects unsafe URLs, unknown tools, and malformed runner responses without leaking errors", async () => {
    const backend = {
      fetch: vi.fn().mockRejectedValue(new Error(url)),
    } satisfies WebFetchBackend;
    const tool = new WebFetchTool({ backend });
    const context = { runId, signal: new AbortController().signal };

    await expect(tool.execute(makeCall("other.tool", {}), context)).resolves.toMatchObject({
      outcome: "error",
      errorCode: "sandbox_fetch_unknown_tool",
    });
    await expect(
      tool.execute(makeCall("web.fetch", { url: "******example.test/" }), context),
    ).resolves.toMatchObject({ outcome: "error", errorCode: "sandbox_fetch_invalid" });
    await expect(tool.execute(makeCall("web.fetch", { url }), context)).resolves.toMatchObject({
      outcome: "error",
      errorCode: "sandbox_fetch_failed",
    });
    expect(
      JSON.stringify(await tool.execute(makeCall("web.fetch", { url }), context)),
    ).not.toContain("synthetic-canary");
  });
});
