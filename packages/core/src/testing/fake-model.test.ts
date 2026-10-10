// SPDX-License-Identifier: Apache-2.0
import { SequentialIdGenerator } from "@harness/schemas";
import { describe, expect, it } from "vitest";
import { FakeModelPort, FakeModelScriptExhaustedError } from "./index.js";
import type { ModelCompletion } from "../ports.js";

const completion: ModelCompletion = {
  content: "answer",
  toolCalls: [],
  usage: { inputTokens: 1, outputTokens: 2 },
  finishReason: "stop",
  provider: "fake",
  model: "fake",
  latencyMs: 0,
  schemaValid: true,
  repairAttempts: 0,
  providerBlobs: null,
};

describe("FakeModelPort", () => {
  it("returns scripted responses and captures requests and context", async () => {
    const model = new FakeModelPort([completion]);
    const request = {
      requestId: new SequentialIdGenerator().next(),
      messages: ["input"],
    };
    const context = { runId: request.requestId, signal: new AbortController().signal };

    await expect(model.complete(request, context)).resolves.toBe(completion);
    expect(model.requests).toEqual([{ request, context }]);
  });

  it("throws a stable error when the response script is exhausted", async () => {
    const model = new FakeModelPort([]);
    const request = {
      requestId: new SequentialIdGenerator().next(),
      messages: [],
    };

    await expect(
      model.complete(request, { runId: request.requestId, signal: new AbortController().signal }),
    ).rejects.toBeInstanceOf(FakeModelScriptExhaustedError);
  });

  it("returns the same scripted response when a conversation position is replayed", async () => {
    const model = new FakeModelPort([completion], {
      responseIndex: (request) =>
        typeof request.messages === "object" &&
        request.messages !== null &&
        !Array.isArray(request.messages) &&
        typeof request.messages.position === "number"
          ? request.messages.position
          : 0,
    });
    const request = {
      requestId: new SequentialIdGenerator().next(),
      messages: { position: 0 },
    };
    const context = { runId: request.requestId, signal: new AbortController().signal };

    await expect(model.complete(request, context)).resolves.toBe(completion);
    await expect(model.complete(request, context)).resolves.toBe(completion);
    expect(model.requests).toHaveLength(2);
  });
});
