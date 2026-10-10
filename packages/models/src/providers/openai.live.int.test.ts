// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { OpenAIAdapter } from "./openai.js";

const id = "00000000000000000000000000";

describe.skipIf(process.env.OPENAI_API_KEY === undefined)("LIVE OpenAI adapter", () => {
  it("completes a request with the configured OpenAI credentials", async () => {
    const adapter = new OpenAIAdapter({
      apiKey: { reveal: () => process.env.OPENAI_API_KEY ?? "" },
    });
    const result = await adapter.complete(
      {
        requestId: id,
        model: {
          provider: "openai",
          model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
        },
        messages: [{ role: "user", parts: [{ type: "text", text: "Say hello." }] }],
      },
      {
        signal: new AbortController().signal,
        ids: { next: () => id },
        clock: { now: () => Date.now() },
      },
    );

    expect(result.parts.some((part) => part.type === "text")).toBe(true);
  });
});
