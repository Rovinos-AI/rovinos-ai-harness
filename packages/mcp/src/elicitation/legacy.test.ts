// SPDX-License-Identifier: Apache-2.0
import { UrlElicitationRequiredError } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";
import { McpProtocolError } from "../errors.js";
import {
  handleLegacyLiveElicitation,
  LegacyElicitationCompletionTracker,
  legacyUrlInputRequiredResult,
} from "./legacy.js";

const request = {
  inputKey: "elicitation-id",
  mode: "url" as const,
  message: "Continue in your browser",
  url: "https://example.test/account",
};

describe("legacy elicitation handling", () => {
  it("answers an active live request through its handler", async () => {
    const handle = vi.fn(() => Promise.resolve({ action: "accept" as const }));
    await expect(
      handleLegacyLiveElicitation({
        active: true,
        request,
        timeoutMs: 100,
        signal: new AbortController().signal,
        handle,
        onTimeout: vi.fn(() => Promise.resolve()),
      }),
    ).resolves.toEqual({ action: "accept", content: {} });
    expect(handle).toHaveBeenCalledWith(request, expect.any(AbortSignal));
  });

  it("cancels a request outside an active tool call", async () => {
    const handle = vi.fn(() => Promise.resolve({ action: "accept" as const }));
    await expect(
      handleLegacyLiveElicitation({
        active: false,
        request,
        timeoutMs: 100,
        signal: new AbortController().signal,
        handle,
        onTimeout: vi.fn(() => Promise.resolve()),
      }),
    ).resolves.toEqual({ action: "cancel", content: {} });
    expect(handle).not.toHaveBeenCalled();
  });

  it.each([
    ["zero timeout", { timeoutMs: 0 }],
    ["invalid timeout", { timeoutMs: Number.NaN }],
    ["invalid request", { request: { mode: "invalid" } }],
  ])("cancels a live request with a %s", async (_label, overrides) => {
    const handle = vi.fn(() => Promise.resolve({ action: "accept" as const }));
    await expect(
      handleLegacyLiveElicitation({
        active: true,
        request,
        timeoutMs: 100,
        signal: new AbortController().signal,
        handle,
        onTimeout: vi.fn(() => Promise.resolve()),
        ...overrides,
      }),
    ).resolves.toEqual({ action: "cancel", content: {} });
    expect(handle).not.toHaveBeenCalled();
  });

  it("cancels before starting when the call signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const handle = vi.fn(() => Promise.resolve({ action: "accept" as const }));
    await expect(
      handleLegacyLiveElicitation({
        active: true,
        request,
        timeoutMs: 100,
        signal: controller.signal,
        handle,
        onTimeout: vi.fn(() => Promise.resolve()),
      }),
    ).resolves.toEqual({ action: "cancel", content: {} });
    expect(handle).not.toHaveBeenCalled();
  });

  it("records timeout and cancels when a live answer does not arrive", async () => {
    const onTimeout = vi.fn(() => Promise.resolve());
    await expect(
      handleLegacyLiveElicitation({
        active: true,
        request,
        timeoutMs: 1,
        signal: new AbortController().signal,
        handle: () => new Promise(() => undefined),
        onTimeout,
      }),
    ).resolves.toEqual({ action: "cancel", content: {} });
    expect(onTimeout).toHaveBeenCalledWith(request);
  });

  it("cancels an active request when its call is aborted while waiting", async () => {
    const controller = new AbortController();
    const handle = vi.fn(
      () =>
        new Promise<{ readonly action: "accept" }>((resolve) => {
          controller.abort();
          resolve({ action: "accept" });
        }),
    );
    await expect(
      handleLegacyLiveElicitation({
        active: true,
        request,
        timeoutMs: 100,
        signal: controller.signal,
        handle,
        onTimeout: vi.fn(() => Promise.resolve()),
      }),
    ).resolves.toEqual({ action: "cancel", content: {} });
  });

  it("cancels an empty response and isolates handler and timeout callback failures", async () => {
    const options = {
      active: true,
      request,
      timeoutMs: 100,
      signal: new AbortController().signal,
      onTimeout: vi.fn(() => Promise.resolve()),
    };
    await expect(
      handleLegacyLiveElicitation({
        ...options,
        handle: () => Promise.resolve(undefined),
      }),
    ).resolves.toEqual({ action: "cancel", content: {} });
    await expect(
      handleLegacyLiveElicitation({
        ...options,
        handle: () => Promise.reject(new Error("channel failed")),
      }),
    ).resolves.toEqual({ action: "cancel", content: {} });
  });

  it("converts an invalid legacy response to cancellation", async () => {
    await expect(
      handleLegacyLiveElicitation({
        active: true,
        request,
        timeoutMs: 100,
        signal: new AbortController().signal,
        handle: () => Promise.resolve({ action: "accept", answer: ["not", "an", "object"] }),
        onTimeout: vi.fn(() => Promise.resolve()),
      }),
    ).resolves.toEqual({ action: "cancel", content: {} });
  });

  it("converts the SDK's -32042 URLs into legacy-keyed input requests", () => {
    const urls = [
      {
        mode: "url" as const,
        elicitationId: "elicitation-id",
        message: "Continue in your browser",
        url: "https://example.test/account",
      },
    ];
    const sdkError = new UrlElicitationRequiredError(urls);
    const result = legacyUrlInputRequiredResult(new McpProtocolError(sdkError.code, urls));
    expect(result).toMatchObject({
      resultType: "input_required",
      inputRequests: {
        "elicitation-id": {
          method: "elicitation/create",
          params: {
            mode: "url",
            message: "Continue in your browser",
            url: "https://example.test/account",
          },
        },
      },
    });
  });

  it("rejects -32042 errors without URLs and ignores unrelated protocol errors", () => {
    expect(legacyUrlInputRequiredResult(new McpProtocolError(-32042))).toBeUndefined();
    expect(legacyUrlInputRequiredResult(new McpProtocolError(-32042, []))).toBeUndefined();
    expect(legacyUrlInputRequiredResult(new McpProtocolError(-32000, []))).toBeUndefined();
  });

  it("ignores unknown completion notifications and consumes a matching ID once", () => {
    const tracker = new LegacyElicitationCompletionTracker();
    tracker.track("known");
    expect(tracker.complete("unknown")).toBe(false);
    expect(tracker.complete("known")).toBe(true);
    expect(tracker.complete("known")).toBe(false);
    tracker.clear();
  });
});
