// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import type { ModelRequest } from "@harness/schemas";
import { z } from "zod";
import { ProviderError } from "./errors.js";
import { ModelGateway } from "./gateway.js";
import * as ModelExports from "./index.js";
import { AdapterRegistry } from "./registry.js";
import type { ProviderAdapter } from "./types.js";
import { FakeProvider } from "./testing/fake-provider.js";

const request: ModelRequest = {
  requestId: "00000000000000000000000000",
  model: { provider: "sample", model: "model-a" },
  messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }],
};

describe("ModelGateway", () => {
  it("selects the request provider and maps its result to a ModelPort completion", async () => {
    expect(ModelExports.ModelGateway).toBe(ModelGateway);
    const complete = vi.fn((_request: ModelRequest) =>
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

  it("lowers and validates native structured output", async () => {
    const complete = vi.fn((_request: ModelRequest) =>
      Promise.resolve({
        parts: [{ type: "text" as const, text: '{"answer":"ok"}' }],
        usage: { inputTokens: 2, outputTokens: 3 },
        finishReason: "stop",
        latencyMs: 7,
      }),
    );
    const gateway = new ModelGateway(new AdapterRegistry([{ provider: "openai", complete }]), {
      ids: { next: () => request.requestId },
      clock: { now: () => 0 },
    });
    const outputSchema = z.object({ answer: z.string() }).strict();
    const completion = await gateway.complete(
      { ...request, model: { provider: "openai", model: "model-a" } },
      { runId: request.requestId, signal: new AbortController().signal, outputSchema },
    );

    expect(complete.mock.calls[0]?.[0].output?.schema).toMatchObject({
      type: "object",
      properties: { answer: { type: "string" } },
    });
    expect(completion).toMatchObject({
      schemaValid: true,
      rungUsed: "native",
      enforcement: { valid: true, value: { answer: "ok" } },
    });
  });

  it("returns invalid native output as structured issues", async () => {
    const adapter: ProviderAdapter = {
      provider: "openai",
      complete: () =>
        Promise.resolve({
          parts: [{ type: "text", text: "not-json" }],
          usage: { inputTokens: 0, outputTokens: 0 },
          finishReason: "stop",
          latencyMs: 0,
        }),
    };
    const gateway = new ModelGateway(new AdapterRegistry([adapter]), {
      ids: { next: () => request.requestId },
      clock: { now: () => 0 },
    });
    const completion = await gateway.complete(
      { ...request, model: { provider: "openai", model: "model-a" } },
      {
        runId: request.requestId,
        signal: new AbortController().signal,
        outputSchema: z.object({ answer: z.string() }),
      },
    );

    expect(completion.schemaValid).toBe(false);
    expect(completion.enforcement).toMatchObject({
      valid: false,
      rungUsed: "native",
      issues: [{ path: [], code: "invalid_json" }],
    });
    expect(JSON.stringify(completion.enforcement)).not.toContain("not-json");
  });

  it("uses the forced tool rung and removes its synthetic call", async () => {
    const complete = vi.fn((_request: ModelRequest) =>
      Promise.resolve({
        parts: [
          {
            type: "tool_call" as const,
            callId: request.requestId,
            toolId: "emit_result",
            args: { answer: "ok" },
          },
        ],
        usage: { inputTokens: 2, outputTokens: 3 },
        finishReason: "tool_use",
        latencyMs: 7,
      }),
    );
    const gateway = new ModelGateway(new AdapterRegistry([{ provider: "anthropic", complete }]), {
      ids: { next: () => request.requestId },
      clock: { now: () => 0 },
    });
    const completion = await gateway.complete(
      { ...request, model: { provider: "anthropic", model: "model-a" } },
      {
        runId: request.requestId,
        signal: new AbortController().signal,
        outputSchema: z.object({ answer: z.string() }).strict(),
      },
    );

    expect(complete.mock.calls[0]?.[0].toolChoice).toEqual({ forced: "emit_result" });
    expect(complete.mock.calls[0]?.[0].tools?.[0]?.toolId).toBe("emit_result");
    expect(completion.parts).toEqual([{ type: "text", text: '{"answer":"ok"}' }]);
    expect(completion).toMatchObject({
      schemaValid: true,
      rungUsed: "tool",
      enforcement: { valid: true, value: { answer: "ok" } },
    });
  });

  it("rejects native output that also contains tool calls", async () => {
    const adapter: ProviderAdapter = {
      provider: "openai",
      complete: () =>
        Promise.resolve({
          parts: [
            { type: "text", text: '{"answer":"ok"}' },
            {
              type: "tool_call",
              callId: request.requestId,
              toolId: "lookup",
              args: {},
            },
          ],
          usage: { inputTokens: 0, outputTokens: 0 },
          finishReason: "tool_calls",
          latencyMs: 0,
        }),
    };
    const gateway = new ModelGateway(new AdapterRegistry([adapter]), {
      ids: { next: () => request.requestId },
      clock: { now: () => 0 },
    });
    const completion = await gateway.complete(
      { ...request, model: { provider: "openai", model: "model-a" } },
      {
        runId: request.requestId,
        signal: new AbortController().signal,
        outputSchema: z.object({ answer: z.string() }),
      },
    );

    expect(completion.parts).toEqual([{ type: "text", text: '{"answer":"ok"}' }]);
    expect(completion.enforcement).toMatchObject({
      valid: false,
      issues: [{ code: "unexpected_tool_call" }],
    });
  });

  it("rejects structured output combined with real tools", async () => {
    const adapter: ProviderAdapter = {
      provider: "openai",
      complete: () => Promise.reject(new Error("must not call adapter")),
    };
    const gateway = new ModelGateway(new AdapterRegistry([adapter]), {
      ids: { next: () => request.requestId },
      clock: { now: () => 0 },
    });

    await expect(
      gateway.complete(
        {
          ...request,
          model: { provider: "openai", model: "model-a" },
          tools: [{ toolId: "lookup", description: "Lookup", inputSchema: {} }],
        },
        {
          runId: request.requestId,
          signal: new AbortController().signal,
          outputSchema: z.object({ answer: z.string() }),
        },
      ),
    ).rejects.toMatchObject({ code: "output_with_tools_unsupported" });
  });

  it("does not call a provider when maxRung disallows its only rung", async () => {
    const provider = new FakeProvider("anthropic", []);
    const gateway = new ModelGateway(
      new AdapterRegistry([provider]),
      { ids: { next: () => request.requestId }, clock: { now: () => 0 } },
      { maxRung: "native" },
    );

    await expect(
      gateway.complete(
        { ...request, model: { provider: "anthropic", model: "model-a" } },
        {
          runId: request.requestId,
          signal: new AbortController().signal,
          outputSchema: z.object({ answer: z.string() }),
        },
      ),
    ).rejects.toMatchObject({ code: "rung_unavailable" });
    expect(provider.requests).toEqual([]);
  });

  it("treats providers without schema rules as having no available rung", async () => {
    const complete = vi.fn(() =>
      Promise.resolve({
        parts: [{ type: "text" as const, text: '{"answer":"ok"}' }],
        usage: { inputTokens: 0, outputTokens: 0 },
        finishReason: "stop",
        latencyMs: 0,
      }),
    );
    const adapter: ProviderAdapter = {
      provider: "sample",
      capabilities: { structuredOutput: "native" },
      complete,
    };
    const gateway = new ModelGateway(new AdapterRegistry([adapter]), {
      ids: { next: () => request.requestId },
      clock: { now: () => 0 },
    });

    await expect(
      gateway.complete(
        { ...request, model: { provider: "sample", model: "model-a" } },
        {
          runId: request.requestId,
          signal: new AbortController().signal,
          outputSchema: z.object({ answer: z.string() }),
        },
      ),
    ).rejects.toMatchObject({ code: "rung_unavailable" });
    expect(complete).not.toHaveBeenCalled();
  });
});
