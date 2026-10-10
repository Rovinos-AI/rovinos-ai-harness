// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import type { ModelRequest } from "@harness/schemas";
import { ModelGateway } from "./gateway.js";
import * as ModelExports from "./index.js";
import { AdapterRegistry } from "./registry.js";
import type { ProviderAdapter } from "./types.js";

const request: ModelRequest = {
  requestId: "00000000000000000000000000",
  model: { provider: "sample", model: "model-a" },
  messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }],
};

describe("ModelGateway", () => {
  it("selects the request provider and maps its result to a ModelPort completion", async () => {
    expect(ModelExports.ModelGateway).toBe(ModelGateway);
    const complete = vi.fn(() =>
      Promise.resolve({
        parts: [{ type: "text" as const, text: "answer" }],
        usage: { inputTokens: 2, outputTokens: 3 },
        finishReason: "stop",
        latencyMs: 7,
      }),
    );
    const adapter: ProviderAdapter = { provider: "sample", complete };
    const ids = { next: () => request.requestId };
    const clock = { now: () => 0 };
    const gateway = new ModelGateway(new AdapterRegistry([adapter]), { ids, clock });
    const signal = new AbortController().signal;

    const completion = await gateway.complete(request, {
      runId: request.requestId,
      signal,
    });

    expect(complete).toHaveBeenCalledWith(request, { signal, ids, clock });
    expect(completion).toEqual({
      parts: [{ type: "text", text: "answer" }],
      usage: { inputTokens: 2, outputTokens: 3 },
      finishReason: "stop",
      provider: "sample",
      model: "model-a",
      latencyMs: 7,
      schemaValid: true,
      repairAttempts: 0,
      fallbackDepth: 0,
      providerBlobs: null,
    });
  });
});
