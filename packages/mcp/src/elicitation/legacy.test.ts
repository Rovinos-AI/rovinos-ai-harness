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

  it("ignores unknown completion notifications and consumes a matching ID once", () => {
    const tracker = new LegacyElicitationCompletionTracker();
    tracker.track("known");
    expect(tracker.complete("unknown")).toBe(false);
    expect(tracker.complete("known")).toBe(true);
    expect(tracker.complete("known")).toBe(false);
    tracker.clear();
  });
});
