// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { AnthropicAdapter } from "./anthropic.js";
import type { ModelRequest } from "@rovinos/schemas";

const apiKey = process.env.ANTHROPIC_API_KEY;
const hasApiKey = apiKey !== undefined && apiKey.length > 0;

describe.skipIf(!hasApiKey)("LIVE Anthropic Messages API", () => {
  it("completes a minimal message with the configured API key", async () => {
    if (!hasApiKey) {
      return;
    }
    const adapter = new AnthropicAdapter({ apiKey: { reveal: () => apiKey } });
    const request: ModelRequest = {
      requestId: "00000000000000000000000000",
      model: { provider: "anthropic", model: "claude-sonnet-5-5" },
      messages: [{ role: "user", parts: [{ type: "text", text: "Reply with one word." }] }],
      maxOutputTokens: 16,
    };
    const result = await adapter.complete(request, {
      signal: new AbortController().signal,
      ids: { next: () => request.requestId },
      clock: { now: () => 0 },
    });
    expect(result.parts.some((part) => part.type === "text")).toBe(true);
  });
});
