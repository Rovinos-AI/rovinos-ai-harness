// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { ModelRetryConfigSchema, type ModelRequest } from "@harness/schemas";
import { ProviderError } from "./errors.js";
import { ModelGateway } from "./gateway.js";
import * as ModelExports from "./index.js";
import { AdapterRegistry } from "./registry.js";
import type { ProviderAdapter, ProviderContext } from "./types.js";

const request: ModelRequest = {
  requestId: "00000000000000000000000000",
  model: { provider: "sample", model: "model-a" },
  messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }],
};

describe("ModelGateway", () => {
  it("selects the request provider and maps its result to a ModelPort completion", async () => {
    expect(ModelExports.ModelGateway).toBe(ModelGateway);
    const complete = vi.fn((_request: ModelRequest, _context: ProviderContext) =>
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

    const call = complete.mock.calls[0];
    expect(call?.[0]).toBe(request);
    expect(call?.[1].ids).toBe(ids);
    expect(call?.[1].clock).toBe(clock);
    expect(call?.[1].signal).not.toBe(signal);
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

  it("retries retryable provider failures under the configured policy", async () => {
    let calls = 0;
    const complete = vi.fn((_request: ModelRequest, _context: ProviderContext) => {
      calls += 1;
      if (calls === 1) {
        return Promise.reject(new ProviderError("provider_unavailable"));
      }
      return Promise.resolve({
        parts: [{ type: "text" as const, text: "answer" }],
        usage: { inputTokens: 2, outputTokens: 3 },
        finishReason: "stop",
        latencyMs: 7,
      });
    });
    const gateway = new ModelGateway(new AdapterRegistry([{ provider: "sample", complete }]), {
      ids: { next: () => request.requestId },
      clock: { now: () => 0 },
      retryPolicy: ModelRetryConfigSchema.parse({ maxAttempts: 2 }),
      random: () => 0,
      sleep: () => Promise.resolve(),
    });

    const completion = await gateway.complete(request, {
      runId: request.requestId,
      signal: new AbortController().signal,
      deadlineTs: 10_000,
    });

    expect(complete).toHaveBeenCalledTimes(2);
    const call = complete.mock.calls[1];
    expect(call?.[1].deadlineTs).toBe(10_000);
    expect(call?.[1].signal.aborted).toBe(false);
    expect(completion.parts).toEqual([{ type: "text", text: "answer" }]);
  });

  it("fails fast for non-retryable provider failures", async () => {
    const complete = vi.fn(() => Promise.reject(new ProviderError("provider_auth")));
    const gateway = new ModelGateway(new AdapterRegistry([{ provider: "sample", complete }]), {
      ids: { next: () => request.requestId },
      clock: { now: () => 0 },
      retryPolicy: ModelRetryConfigSchema.parse({ maxAttempts: 3 }),
    });

    await expect(
      gateway.complete(request, {
        runId: request.requestId,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "provider_auth" });
    expect(complete).toHaveBeenCalledOnce();
  });

  it("limits requests by the configured provider", async () => {
    let now = 0;
    const delays: number[] = [];
    const complete = vi.fn((_request: ModelRequest, _context: ProviderContext) =>
      Promise.resolve({
        parts: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        finishReason: "stop",
        latencyMs: 0,
      }),
    );
    const gateway = new ModelGateway(new AdapterRegistry([{ provider: "sample", complete }]), {
      ids: { next: () => request.requestId },
      clock: { now: () => now },
      requestsPerMinute: { sample: 1 },
      sleep: (delay) => {
        delays.push(delay);
        now += delay;
        return Promise.resolve();
      },
    });
    const signal = new AbortController().signal;

    await gateway.complete(request, { runId: request.requestId, signal });
    await gateway.complete(request, { runId: request.requestId, signal });

    expect(delays).toEqual([60_000]);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("maps invalid adapter output to provider_unknown without metadata", async () => {
    const adapter: ProviderAdapter = {
      provider: "sample",
      complete: () =>
        Promise.resolve({
          parts: [],
          usage: { inputTokens: -1, outputTokens: 0 },
          finishReason: "stop",
          latencyMs: 0,
        }),
    };
    const gateway = new ModelGateway(new AdapterRegistry([adapter]), {
      ids: { next: () => request.requestId },
      clock: { now: () => 0 },
    });

    const error = await gateway
      .complete(request, {
        runId: request.requestId,
        signal: new AbortController().signal,
      })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );

    expect(error).toBeInstanceOf(ProviderError);
    if (!(error instanceof ProviderError)) {
      return;
    }
    expect(error.code).toBe("provider_unknown");
    expect(error).not.toHaveProperty("retryAfterMs");
    expect(error).not.toHaveProperty("status");
  });
});
