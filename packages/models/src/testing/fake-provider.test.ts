// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { FakeProvider, FakeProviderScriptExhaustedError } from "./fake-provider.js";
import * as TestingExports from "./index.js";

const request = {
  requestId: "00000000000000000000000000",
  model: { provider: "fake", model: "model-a" },
  messages: [],
};
const context = {
  signal: new AbortController().signal,
  ids: { next: () => request.requestId },
  clock: { now: () => 0 },
};
const result = {
  parts: [{ type: "text" as const, text: "answer" }],
  usage: { inputTokens: 1, outputTokens: 2 },
  finishReason: "stop",
  latencyMs: 3,
};

describe("FakeProvider", () => {
  it("replays scripted results and captures each request", async () => {
    expect(TestingExports.FakeProvider).toBe(FakeProvider);
    const provider = new FakeProvider("fake", [result, result]);

    await expect(provider.complete(request, context)).resolves.toBe(result);
    await expect(provider.complete(request, context)).resolves.toBe(result);
    expect(provider.requests).toEqual([request, request]);
  });

  it("throws a typed error when the result script is exhausted", async () => {
    const provider = new FakeProvider("fake", []);

    await expect(provider.complete(request, context)).rejects.toBeInstanceOf(
      FakeProviderScriptExhaustedError,
    );
    expect(provider.requests).toEqual([request]);
  });
});
