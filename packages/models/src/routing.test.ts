// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { ModelsConfigSchema, type ModelRequest } from "@harness/schemas";
import { attr, defineSpan, withSpan } from "@harness/telemetry";
import { createTestContextManager, createTestTracerProvider } from "@harness/telemetry/testing";
import { context, trace } from "@opentelemetry/api";
import { z } from "zod";
import { ModelOutputInvalidError, ProviderError } from "./errors.js";
import { createRoutingModelGateway, RoutingProviderUnknownError } from "./routing.js";
import type { ModelRoutingConfig } from "./routing.js";
import type { ProviderAdapter, ProviderResult } from "./types.js";

const request: ModelRequest = {
  requestId: "00000000000000000000000000",
  model: { provider: "primary", model: "model-one" },
  messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }],
};

const result: ProviderResult = {
  parts: [{ type: "text", text: "answer" }],
  usage: { inputTokens: 2, outputTokens: 3 },
  finishReason: "stop",
  latencyMs: 5,
};

const dependencies = {
  ids: { next: () => request.requestId },
  clock: { now: () => 0 },
  retryPolicy: {
    maxAttempts: 1,
    baseDelayMs: 0,
    maxDelayMs: 0,
    timeoutMs: 1_000,
    streamTimeoutMs: 600_000,
    idleTimeoutMs: 1_000,
  },
  enforcement: { maxRepairs: 0 },
};

function routing(config: unknown): ModelRoutingConfig {
  return ModelsConfigSchema.parse({ routing: config }).routing;
}

function adapter(provider: string, complete: ProviderAdapter["complete"]): ProviderAdapter {
  return { provider, kind: "openai", complete };
}

describe("RoutingModelGateway", () => {
  it("preserves cached usage for a single route", async () => {
    const cachedResult: ProviderResult = {
      ...result,
      usage: { inputTokens: 2, outputTokens: 3, cacheReadTokens: 4, cacheWriteTokens: 1 },
    };
    const gateway = createRoutingModelGateway(
      [adapter("primary", () => Promise.resolve(cachedResult))],
      dependencies,
      routing({ default: [{ provider: "primary", model: "model-one" }] }),
    );

    const response = await gateway.complete(request, {
      runId: request.requestId,
      signal: new AbortController().signal,
    });

    expect(response.usage).toEqual({
      inputTokens: 2,
      outputTokens: 3,
      cacheReadTokens: 4,
      cacheWriteTokens: 1,
    });
  });

  it("falls through candidates in order and reports the actual model and fallback depth", async () => {
    const primary = adapter("primary", () =>
      Promise.reject(new ProviderError("provider_unavailable")),
    );
    const secondaryComplete = vi.fn((_request: ModelRequest) => Promise.resolve(result));
    const secondary = adapter("secondary", secondaryComplete);
    const gateway = createRoutingModelGateway(
      [primary, secondary],
      dependencies,
      routing({
        default: [
          { provider: "primary", model: "model-one" },
          { provider: "secondary", model: "model-two" },
        ],
      }),
    );

    const response = await gateway.complete(request, {
      runId: request.requestId,
      signal: new AbortController().signal,
    });

    expect(secondaryComplete).toHaveBeenCalledWith(
      expect.objectContaining({ model: { provider: "secondary", model: "model-two" } }),
      expect.anything(),
    );
    expect(response).toMatchObject({
      provider: "secondary",
      model: "model-two",
      fallbackDepth: 1,
      parts: result.parts,
    });
  });

  it("uses the selected provider's output-token limit after fallback", async () => {
    const primaryComplete = vi.fn((_request: ModelRequest) =>
      Promise.reject(new ProviderError("provider_unavailable")),
    );
    const secondaryComplete = vi.fn((_request: ModelRequest) => Promise.resolve(result));
    const gateway = createRoutingModelGateway(
      [
        { ...adapter("primary", primaryComplete), maxOutputTokens: 128 },
        { ...adapter("secondary", secondaryComplete), maxOutputTokens: 768 },
      ],
      dependencies,
      routing({
        default: [
          { provider: "primary", model: "model-one" },
          { provider: "secondary", model: "model-two" },
        ],
      }),
    );

    await gateway.complete(request, {
      runId: request.requestId,
      signal: new AbortController().signal,
    });

    expect(primaryComplete.mock.calls[0]?.[0].maxOutputTokens).toBe(128);
    expect(secondaryComplete.mock.calls[0]?.[0].maxOutputTokens).toBe(768);
  });

  it("does not fall back for errors outside fallbackOn", async () => {
    const primary = adapter("primary", () => Promise.reject(new ProviderError("provider_auth")));
    const secondaryComplete = vi.fn((_request: ModelRequest) => Promise.resolve(result));
    const gateway = createRoutingModelGateway(
      [primary, adapter("secondary", secondaryComplete)],
      dependencies,
      routing({
        default: [
          { provider: "primary", model: "model-one" },
          { provider: "secondary", model: "model-two" },
        ],
      }),
    );

    await expect(
      gateway.complete(request, {
        runId: request.requestId,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "provider_auth" });
    expect(secondaryComplete).not.toHaveBeenCalled();
  });

  it("uses role routes instead of the default route", async () => {
    const selectedComplete = vi.fn(() => Promise.resolve(result));
    const gateway = createRoutingModelGateway(
      [
        adapter("primary", () => Promise.resolve(result)),
        adapter("role-provider", selectedComplete),
      ],
      dependencies,
      routing({
        default: [{ provider: "primary", model: "model-one" }],
        roles: {
          planner: [{ provider: "role-provider", model: "planner-model" }],
        },
      }),
    );

    const response = await gateway.complete(
      { ...request, role: "planner" },
      {
        runId: request.requestId,
        signal: new AbortController().signal,
      },
    );

    expect(selectedComplete).toHaveBeenCalledOnce();
    expect(response).toMatchObject({ provider: "role-provider", model: "planner-model" });
  });

  it("uses the default route when a role route is empty", async () => {
    const selectedComplete = vi.fn(() => Promise.resolve(result));
    const gateway = createRoutingModelGateway(
      [adapter("primary", selectedComplete)],
      dependencies,
      routing({
        default: [{ provider: "primary", model: "default-model" }],
        roles: { planner: [] },
      }),
    );

    const response = await gateway.complete(
      { ...request, role: "planner" },
      {
        runId: request.requestId,
        signal: new AbortController().signal,
      },
    );

    expect(response).toMatchObject({ provider: "primary", model: "default-model" });
  });

  it("drops foreign opaque parts when trying the next provider", async () => {
    const messages = [
      {
        role: "assistant" as const,
        parts: [
          { type: "text" as const, text: "continue" },
          { type: "opaque" as const, provider: "primary", blob: { private: "opaque" } },
        ],
      },
    ];
    const primary = adapter("primary", () =>
      Promise.reject(new ProviderError("provider_unavailable")),
    );
    const secondaryComplete = vi.fn((_request: ModelRequest) => Promise.resolve(result));
    const gateway = createRoutingModelGateway(
      [primary, adapter("secondary", secondaryComplete)],
      dependencies,
      routing({
        default: [
          { provider: "primary", model: "model-one" },
          { provider: "secondary", model: "model-two" },
        ],
      }),
    );

    await gateway.complete(
      { ...request, messages },
      {
        runId: request.requestId,
        signal: new AbortController().signal,
      },
    );

    expect(secondaryComplete.mock.calls[0]?.[0].messages).toEqual([
      { role: "assistant", parts: [{ type: "text", text: "continue" }] },
    ]);
  });

  it("allows model-output-invalid errors to trigger the configured fallback", async () => {
    const primary = adapter("primary", () =>
      Promise.reject(new ModelOutputInvalidError(0, [{ path: ["answer"], code: "invalid_type" }])),
    );
    const secondaryComplete = vi.fn((_request: ModelRequest) => Promise.resolve(result));
    const gateway = createRoutingModelGateway(
      [primary, adapter("secondary", secondaryComplete)],
      dependencies,
      routing({
        default: [
          { provider: "primary", model: "model-one" },
          { provider: "secondary", model: "model-two" },
        ],
      }),
    );

    await gateway.complete(request, {
      runId: request.requestId,
      signal: new AbortController().signal,
    });

    expect(secondaryComplete).toHaveBeenCalledOnce();
  });

  it("adds failed repair usage and latency to the successful fallback response", async () => {
    const provider = createTestTracerProvider();
    trace.setGlobalTracerProvider(provider);
    context.setGlobalContextManager(createTestContextManager());
    const spanDefinition = defineSpan(
      "harness.model_routing_accounting_test",
      {
        "harness.run.id": attr.id(),
        "harness.model.attempts": attr.optional(attr.int()),
        "harness.model.repair_attempts": attr.optional(attr.nonnegativeInt()),
        "harness.model.input_tokens": attr.optional(attr.nonnegativeInt()),
        "harness.model.output_tokens": attr.optional(attr.nonnegativeInt()),
        "harness.model.cache_read_tokens": attr.optional(attr.nonnegativeInt()),
        "harness.model.cache_write_tokens": attr.optional(attr.nonnegativeInt()),
        "harness.model.cost_micros": attr.optional(attr.nonnegativeInt()),
      },
      { taskId: "14.14", packageName: "@harness/models" },
    );
    const invalidResult: ProviderResult = {
      parts: [{ type: "text", text: '{"answer":"invalid"}' }],
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
        costMicros: 3,
      },
      finishReason: "stop",
      latencyMs: 7,
    };
    const primaryComplete = vi.fn(() => Promise.resolve(invalidResult));
    const fallbackComplete = vi.fn(() =>
      Promise.resolve({
        parts: [{ type: "text" as const, text: '{"answer":42}' }],
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 3,
          cacheWriteTokens: 2,
          costMicros: 5,
        },
        finishReason: "stop",
        latencyMs: 2,
      }),
    );
    const gateway = createRoutingModelGateway(
      [adapter("primary", primaryComplete), adapter("secondary", fallbackComplete)],
      {
        ...dependencies,
        enforcement: { maxRepairs: 1 },
        pricing: {
          "primary/model-one": {
            inputMicrosPerMTok: 1_000_000,
            outputMicrosPerMTok: 1_000_000,
          },
          "secondary/model-two": {
            inputMicrosPerMTok: 2_000_000,
            outputMicrosPerMTok: 2_000_000,
          },
        },
      },
      routing({
        default: [
          { provider: "primary", model: "model-one" },
          { provider: "secondary", model: "model-two" },
        ],
      }),
    );

    try {
      await withSpan(spanDefinition, { "harness.run.id": request.requestId }, async (span) => {
        const setAttribute = vi.spyOn(span, "setAttribute");
        const response = await context.with(trace.setSpan(context.active(), span), () =>
          gateway.complete(request, {
            runId: request.requestId,
            signal: new AbortController().signal,
            outputSchema: z.object({ answer: z.number() }),
          }),
        );

        expect(primaryComplete).toHaveBeenCalledTimes(2);
        expect(response).toMatchObject({
          provider: "secondary",
          model: "model-two",
          fallbackDepth: 1,
          usage: {
            inputTokens: 30,
            outputTokens: 13,
            cacheReadTokens: 7,
            cacheWriteTokens: 4,
            costMicros: 58,
          },
          latencyMs: 16,
          repairAttempts: 1,
        });
        expect(
          setAttribute.mock.calls.filter(([name]) =>
            [
              "harness.model.input_tokens",
              "harness.model.output_tokens",
              "harness.model.cache_read_tokens",
              "harness.model.cache_write_tokens",
              "harness.model.cost_micros",
            ].includes(name),
          ),
        ).toEqual([
          ["harness.model.input_tokens", 30],
          ["harness.model.output_tokens", 13],
          ["harness.model.cache_read_tokens", 7],
          ["harness.model.cache_write_tokens", 4],
          ["harness.model.cost_micros", 58],
        ]);
      });
    } finally {
      await provider.shutdown();
      trace.disable();
      context.disable();
    }
  });

  it("retains usage when a later repair call fails after an earlier response", async () => {
    let primaryCalls = 0;
    const primary = adapter("primary", () => {
      primaryCalls += 1;
      return primaryCalls === 1
        ? Promise.resolve({
            parts: [{ type: "text" as const, text: '{"answer":"invalid"}' }],
            usage: { inputTokens: 2, outputTokens: 3 },
            finishReason: "stop",
            latencyMs: 4,
          })
        : Promise.reject(new ProviderError("provider_unavailable"));
    });
    const secondary = adapter("secondary", () =>
      Promise.resolve({
        parts: [{ type: "text" as const, text: '{"answer":42}' }],
        usage: { inputTokens: 5, outputTokens: 6 },
        finishReason: "stop",
        latencyMs: 7,
      }),
    );
    const gateway = createRoutingModelGateway(
      [primary, secondary],
      { ...dependencies, enforcement: { maxRepairs: 1 } },
      routing({
        default: [
          { provider: "primary", model: "model-one" },
          { provider: "secondary", model: "model-two" },
        ],
      }),
    );

    const response = await gateway.complete(request, {
      runId: request.requestId,
      signal: new AbortController().signal,
      outputSchema: z.object({ answer: z.number() }),
    });

    expect(response).toMatchObject({
      usage: { inputTokens: 7, outputTokens: 9 },
      latencyMs: 11,
      repairAttempts: 1,
      fallbackDepth: 1,
    });
  });

  it("attaches accumulated usage when the final candidate also fails", async () => {
    const primary = adapter("primary", () =>
      Promise.reject(
        new ModelOutputInvalidError(0, [{ path: ["answer"], code: "invalid_type" }], undefined, {
          usage: {
            inputTokens: 10,
            outputTokens: 3,
            cacheReadTokens: 5,
            cacheWriteTokens: 2,
            costMicros: 4,
          },
          latencyMs: 5,
        }),
      ),
    );
    const finalError = new ProviderError("provider_unavailable");
    const secondary = adapter("secondary", () => Promise.reject(finalError));
    const gateway = createRoutingModelGateway(
      [primary, secondary],
      {
        ...dependencies,
        pricing: {
          "primary/model-one": {
            inputMicrosPerMTok: 1_000_000,
            outputMicrosPerMTok: 2_000_000,
          },
        },
      },
      routing({
        default: [
          { provider: "primary", model: "model-one" },
          { provider: "secondary", model: "model-two" },
        ],
      }),
    );

    await expect(
      gateway.complete(request, {
        runId: request.requestId,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      code: "provider_unavailable",
      usage: {
        inputTokens: 10,
        outputTokens: 3,
        cacheReadTokens: 5,
        cacheWriteTokens: 2,
        costMicros: 16,
      },
      latencyMs: 5,
    });
  });

  it("never falls back after a deadline even when it is configured", async () => {
    const primaryComplete = vi.fn(() => Promise.reject(new ProviderError("provider_unavailable")));
    const secondaryComplete = vi.fn(() => Promise.resolve(result));
    const gateway = createRoutingModelGateway(
      [adapter("primary", primaryComplete), adapter("secondary", secondaryComplete)],
      dependencies,
      routing({
        default: [
          { provider: "primary", model: "model-one" },
          { provider: "secondary", model: "model-two" },
        ],
        fallbackOn: ["deadline_exceeded", "provider_unavailable"],
      }),
    );

    await expect(
      gateway.complete(request, {
        runId: request.requestId,
        signal: new AbortController().signal,
        deadlineTs: 0,
      }),
    ).rejects.toMatchObject({ code: "deadline_exceeded" });
    expect(primaryComplete).not.toHaveBeenCalled();
    expect(secondaryComplete).not.toHaveBeenCalled();
  });

  it("never falls back after run cancellation even when cancellation is configured", async () => {
    const controller = new AbortController();
    const cancelled = Object.assign(new Error("cancelled"), { code: "run_cancelled" });
    controller.abort(cancelled);
    const primaryComplete = vi.fn(() => Promise.reject(new ProviderError("provider_unavailable")));
    const secondaryComplete = vi.fn(() => Promise.resolve(result));
    const gateway = createRoutingModelGateway(
      [adapter("primary", primaryComplete), adapter("secondary", secondaryComplete)],
      dependencies,
      routing({
        default: [
          { provider: "primary", model: "model-one" },
          { provider: "secondary", model: "model-two" },
        ],
        fallbackOn: ["run_cancelled", "provider_unavailable"],
      }),
    );

    await expect(
      gateway.complete(request, { runId: request.requestId, signal: controller.signal }),
    ).rejects.toBe(cancelled);
    expect(primaryComplete).not.toHaveBeenCalled();
    expect(secondaryComplete).not.toHaveBeenCalled();
  });

  it("rejects configured routes that reference unknown providers at construction", () => {
    expect(() =>
      createRoutingModelGateway(
        [],
        dependencies,
        routing({ default: [{ provider: "missing", model: "model" }] }),
      ),
    ).toThrowError(RoutingProviderUnknownError);
  });
});
