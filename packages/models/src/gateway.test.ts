// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  JsonValue,
  ModelRetryConfigSchema,
  parseJson,
  type JsonValue as JsonValueType,
  type ModelRequest,
} from "@harness/schemas";
import { attr, defineSpan, withSpan } from "@harness/telemetry";
import { createTestContextManager, createTestTracerProvider } from "@harness/telemetry/testing";
import { context, trace } from "@opentelemetry/api";
import * as telemetry from "@harness/telemetry";
import { z } from "zod";
import { ModelOutputInvalidError, ProviderError } from "./errors.js";
import { ModelGateway } from "./gateway.js";
import * as ModelExports from "./index.js";
import { AdapterRegistry } from "./registry.js";
import { FakeProvider } from "./testing/fake-provider.js";
import type { ProviderAdapter, ProviderContext } from "./types.js";
import type { ValueTransform } from "./index.js";
import { abortableSleep } from "./resilience/retry.js";
import { AnthropicAdapter } from "./providers/anthropic.js";
import { OpenAIAdapter } from "./providers/openai.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function useFakeClock(): void {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  vi.spyOn(AbortSignal, "timeout").mockImplementation((delay) => {
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort(new Error("timeout"));
    }, delay);
    return controller.signal;
  });
}

const request: ModelRequest = {
  requestId: "00000000000000000000000000",
  model: { provider: "sample", model: "model-a" },
  messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }],
};

function expectAnthropicRepairBody(body: JsonValue | undefined): void {
  expect(body).toMatchObject({
    messages: [
      { role: "user" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_00000000000000000000000000",
            name: "emit_result",
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_00000000000000000000000000",
            is_error: true,
            content: "$.answer: expected number",
          },
        ],
      },
    ],
    tool_choice: { type: "tool", name: "emit_result" },
  });
}

function expectOpenAiRepairBody(body: JsonValue | undefined): void {
  expect(body).toMatchObject({
    messages: [
      { role: "user" },
      {
        role: "assistant",
        tool_calls: [
          {
            id: "call_00000000000000000000000000",
            function: { name: "emit_result" },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_00000000000000000000000000",
        content: "$.answer: expected number",
      },
    ],
    tool_choice: { type: "function", function: { name: "emit_result" } },
  });
}

function providerAdapter(
  provider: ProviderAdapter["provider"],
  complete: ProviderAdapter["complete"],
  kind: ProviderAdapter["kind"] = "openai",
): ProviderAdapter {
  return { provider, kind, complete };
}

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
    const adapter: ProviderAdapter = { provider: "sample", kind: "openai", complete };
    const ids = { next: () => request.requestId };
    const clock = { now: () => 0 };
    const gateway = new ModelGateway(new AdapterRegistry([adapter]), { ids, clock });
    const signal = new AbortController().signal;

    const completion = await gateway.complete(request, {
      runId: request.requestId,
      signal,
    });

    const call = complete.mock.calls[0];
    expect(call?.[0]).toEqual({ ...request, maxOutputTokens: 4_096 });
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

  it("removes foreign opaque parts and retains normalized assistant parts", async () => {
    const provider = new FakeProvider("sample", [
      {
        parts: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        finishReason: "stop",
        latencyMs: 0,
      },
    ]);
    const gateway = new ModelGateway(new AdapterRegistry([provider]), {
      ids: { next: () => request.requestId },
      clock: { now: () => 0 },
    });
    const requestWithForeignBlobs: ModelRequest = {
      ...request,
      messages: [
        {
          role: "assistant",
          parts: [
            { type: "text", text: "continue" },
            { type: "tool_call", callId: request.requestId, toolId: "lookup", args: {} },
            { type: "opaque", provider: "other", blob: { raw: true } },
          ],
        },
        {
          role: "user",
          parts: [{ type: "opaque", provider: "other", blob: { raw: true } }],
        },
      ],
    };

    await gateway.complete(requestWithForeignBlobs, {
      runId: request.requestId,
      signal: new AbortController().signal,
    });

    expect(provider.requests[0]?.messages).toEqual([
      {
        role: "assistant",
        parts: [
          { type: "text", text: "continue" },
          { type: "tool_call", callId: request.requestId, toolId: "lookup", args: {} },
        ],
      },
      { role: "user", parts: [] },
    ]);
    expect(
      provider.requests[0]?.messages.flatMap(({ parts }) =>
        parts.filter((part) => part.type === "opaque" && part.provider !== provider.provider),
      ),
    ).toEqual([]);
  });

  it("retries provider failures and records bounded repair attempts on the model span", async () => {
    const provider = createTestTracerProvider();
    trace.setGlobalTracerProvider(provider);
    context.setGlobalContextManager(createTestContextManager());
    const definition = defineSpan(
      "harness.model_call",
      {
        "harness.run.id": attr.id(),
        "harness.event.seq": attr.optional(attr.int()),
        "harness.model.attempts": attr.optional(attr.int()),
        "harness.model.repair_attempts": attr.optional(attr.nonnegativeInt()),
        "harness.model.input_tokens": attr.optional(attr.nonnegativeInt()),
        "harness.model.output_tokens": attr.optional(attr.nonnegativeInt()),
        "harness.model.cache_read_tokens": attr.optional(attr.nonnegativeInt()),
        "harness.model.cache_write_tokens": attr.optional(attr.nonnegativeInt()),
        "harness.model.cost_micros": attr.optional(attr.nonnegativeInt()),
      },
      { taskId: "4.7", packageName: "@harness/models" },
    );
    let calls = 0;
    const complete = vi.fn((_request: ModelRequest, _context: ProviderContext) => {
      calls += 1;
      if (calls < 3) {
        const error = new ProviderError("provider_unavailable");
        if (calls === 1) {
          Object.defineProperty(error, "usage", {
            value: { inputTokens: 1, outputTokens: 2 },
          });
        }
        return Promise.reject(error);
      }
      if (calls === 3) {
        return Promise.resolve({
          parts: [{ type: "text" as const, text: '{"answer":1}' }],
          usage: { inputTokens: 2, outputTokens: 3, costMicros: 4 },
          finishReason: "stop",
          latencyMs: 7,
        });
      }
      return Promise.resolve({
        parts: [{ type: "text" as const, text: '{"answer":"ok"}' }],
        usage: {
          inputTokens: 5,
          outputTokens: 6,
          cacheReadTokens: 2,
          cacheWriteTokens: 1,
          costMicros: 8,
        },
        finishReason: "stop",
        latencyMs: 9,
      });
    });
    const gateway = new ModelGateway(new AdapterRegistry([providerAdapter("sample", complete)]), {
      ids: { next: () => request.requestId },
      clock: { now: () => 0 },
      retryPolicy: ModelRetryConfigSchema.parse({ maxAttempts: 3 }),
      random: () => 0,
      sleep: () => Promise.resolve(),
      pricing: {
        "sample/model-a": {
          inputMicrosPerMTok: 1_000_000,
          outputMicrosPerMTok: 2_000_000,
          cacheReadMicrosPerMTok: 500_000,
          cacheWriteMicrosPerMTok: 250_000,
        },
      },
    });

    try {
      await withSpan(definition, { "harness.run.id": request.requestId }, async (span) => {
        const recordedAttribute = vi.spyOn(span, "setAttribute");
        const completion = await context.with(trace.setSpan(context.active(), span), () =>
          gateway.complete(request, {
            runId: request.requestId,
            signal: new AbortController().signal,
            deadlineTs: 10_000,
            outputSchema: z.object({ answer: z.string() }),
          }),
        );

        expect(complete).toHaveBeenCalledTimes(4);
        const call = complete.mock.calls[3];
        expect(call?.[1].deadlineTs).toBe(10_000);
        expect(call?.[1].signal.aborted).toBe(false);
        expect(completion.parts).toEqual([{ type: "text", text: '{"answer":"ok"}' }]);
        expect(completion).toMatchObject({
          schemaValid: true,
          repairAttempts: 1,
          usage: {
            inputTokens: 8,
            outputTokens: 11,
            cacheReadTokens: 2,
            cacheWriteTokens: 1,
            costMicros: 28,
          },
          latencyMs: 16,
        });
        expect(recordedAttribute.mock.calls).toEqual([
          ["harness.model.repair_attempts", 0],
          ["harness.model.attempts", 1],
          ["harness.model.attempts", 2],
          ["harness.model.attempts", 3],
          ["harness.model.repair_attempts", 1],
          ["harness.model.attempts", 4],
          ["harness.model.input_tokens", 8],
          ["harness.model.output_tokens", 11],
          ["harness.model.cache_read_tokens", 2],
          ["harness.model.cache_write_tokens", 1],
          ["harness.model.cost_micros", 28],
        ]);
      });
    } finally {
      await provider.shutdown();
      trace.disable();
      context.disable();
    }
  });

  it("omits missing prices and logs each model only once", async () => {
    const pricingMissing = vi.spyOn(telemetry, "emitPricingMissing");
    const provider: ProviderAdapter = {
      provider: "sample",
      kind: "openai",
      complete: () =>
        Promise.resolve({
          parts: [],
          usage: { inputTokens: 2, outputTokens: 3, costMicros: 99 },
          finishReason: "stop",
          latencyMs: 0,
        }),
    };
    const gateway = new ModelGateway(new AdapterRegistry([provider]), {
      ids: { next: () => request.requestId },
      clock: { now: () => 0 },
      retryPolicy: ModelRetryConfigSchema.parse({ maxAttempts: 1 }),
    });
    const signal = new AbortController().signal;

    const first = await gateway.complete(request, { runId: request.requestId, signal });
    const second = await gateway.complete(request, { runId: request.requestId, signal });

    expect(first.usage).toEqual({ inputTokens: 2, outputTokens: 3 });
    expect(second.usage).toEqual({ inputTokens: 2, outputTokens: 3 });
    expect(pricingMissing).toHaveBeenCalledExactlyOnceWith("sample", "model-a");
  });

  it("falls back to input pricing and reports a missing cache price once", async () => {
    const pricingCacheMissing = vi.spyOn(telemetry, "emitPricingCacheMissing");
    const provider: ProviderAdapter = {
      provider: "sample",
      kind: "openai",
      complete: () =>
        Promise.resolve({
          parts: [],
          usage: { inputTokens: 10_000, outputTokens: 0, cacheReadTokens: 2_000 },
          finishReason: "stop",
          latencyMs: 0,
        }),
    };
    const gateway = new ModelGateway(new AdapterRegistry([provider]), {
      ids: { next: () => request.requestId },
      clock: { now: () => 0 },
      retryPolicy: ModelRetryConfigSchema.parse({ maxAttempts: 1 }),
      pricing: {
        "sample/model-a": { inputMicrosPerMTok: 100, outputMicrosPerMTok: 0 },
      },
    });
    const signal = new AbortController().signal;

    const first = await gateway.complete(request, { runId: request.requestId, signal });
    const second = await gateway.complete(request, { runId: request.requestId, signal });

    expect(first.usage).toEqual({
      inputTokens: 10_000,
      outputTokens: 0,
      cacheReadTokens: 2_000,
      costMicros: 1,
    });
    expect(second.usage).toEqual(first.usage);
    expect(pricingCacheMissing).toHaveBeenCalledExactlyOnceWith("sample", "model-a");
  });

  it("fails fast for non-retryable provider failures", async () => {
    const complete = vi.fn(() => Promise.reject(new ProviderError("provider_auth")));
    const gateway = new ModelGateway(new AdapterRegistry([providerAdapter("sample", complete)]), {
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
    const gateway = new ModelGateway(new AdapterRegistry([providerAdapter("sample", complete)]), {
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

  it("starts the provider timeout only after a long limiter wait", async () => {
    useFakeClock();
    const complete = vi.fn(async (_request: ModelRequest, adapterContext: ProviderContext) => {
      await abortableSleep(500, adapterContext.signal);
      return {
        parts: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        finishReason: "stop",
        latencyMs: 500,
      };
    });
    const gateway = new ModelGateway(new AdapterRegistry([providerAdapter("sample", complete)]), {
      ids: { next: () => request.requestId },
      clock: { now: () => Date.now() },
      requestsPerMinute: { sample: 1 },
      retryPolicy: ModelRetryConfigSchema.parse({ maxAttempts: 1, timeoutMs: 1_000 }),
    });
    const runContext = {
      runId: request.requestId,
      signal: new AbortController().signal,
      deadlineTs: 120_000,
    };
    const first = gateway.complete(request, runContext);
    await vi.advanceTimersByTimeAsync(500);
    await first;

    const second = gateway.complete(request, runContext);
    const result = second.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(59_499);
    expect(complete).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(501);
    expect(await result).toMatchObject({ finishReason: "stop" });
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[1]?.[1].signal.aborted).toBe(false);
  });

  it("cancels a limiter wait without calling the provider again", async () => {
    useFakeClock();
    const complete = vi.fn(() =>
      Promise.resolve({
        parts: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        finishReason: "stop",
        latencyMs: 0,
      }),
    );
    const gateway = new ModelGateway(new AdapterRegistry([providerAdapter("sample", complete)]), {
      ids: { next: () => request.requestId },
      clock: { now: () => Date.now() },
      requestsPerMinute: { sample: 1 },
    });
    const controller = new AbortController();
    const runContext = { runId: request.requestId, signal: controller.signal };
    await gateway.complete(request, runContext);
    const second = gateway.complete(request, runContext);
    await vi.advanceTimersByTimeAsync(0);
    const cancelled = new Error("cancelled");
    controller.abort(cancelled);

    await expect(second).rejects.toBe(cancelled);
    expect(complete).toHaveBeenCalledOnce();
  });

  it("holds concurrency permits until timed-out adapter calls settle", async () => {
    useFakeClock();
    let active = 0;
    let peak = 0;
    const complete = vi.fn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 50);
      });
      active -= 1;
      return {
        parts: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        finishReason: "stop",
        latencyMs: 50,
      };
    });
    const gateway = new ModelGateway(new AdapterRegistry([providerAdapter("sample", complete)]), {
      ids: { next: () => request.requestId },
      clock: { now: () => Date.now() },
      maxConcurrent: 1,
      retryPolicy: ModelRetryConfigSchema.parse({ maxAttempts: 3, timeoutMs: 10 }),
      random: () => 0,
    });
    const result = gateway
      .complete(request, {
        runId: request.requestId,
        signal: new AbortController().signal,
      })
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(49);
    expect(complete).toHaveBeenCalledOnce();
    expect(active).toBe(1);
    await vi.advanceTimersByTimeAsync(101);

    expect(await result).toMatchObject({ code: "provider_timeout" });
    expect(complete).toHaveBeenCalledTimes(3);
    expect(peak).toBe(1);
    expect(active).toBe(0);
  });

  it("stops semaphore waiting at the run deadline without a provider call", async () => {
    useFakeClock();
    const complete = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 50);
      });
      return {
        parts: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        finishReason: "stop",
        latencyMs: 50,
      };
    });
    const gateway = new ModelGateway(new AdapterRegistry([providerAdapter("sample", complete)]), {
      ids: { next: () => request.requestId },
      clock: { now: () => Date.now() },
      maxConcurrent: 1,
    });
    const runContext = { runId: request.requestId, signal: new AbortController().signal };
    const first = gateway.complete(request, runContext);
    await vi.advanceTimersByTimeAsync(0);
    const second = gateway
      .complete(request, { ...runContext, deadlineTs: 10 })
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10);

    expect(await second).toMatchObject({ code: "deadline_exceeded" });
    expect(complete).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(40);
    await first;
    expect(complete).toHaveBeenCalledOnce();
  });

  it("does not wait for a limiter token that would reach the run deadline", async () => {
    const complete = vi.fn(() =>
      Promise.resolve({
        parts: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        finishReason: "stop",
        latencyMs: 0,
      }),
    );
    const gateway = new ModelGateway(new AdapterRegistry([providerAdapter("sample", complete)]), {
      ids: { next: () => request.requestId },
      clock: { now: () => 0 },
      requestsPerMinute: { sample: 1 },
    });
    const runContext = {
      runId: request.requestId,
      signal: new AbortController().signal,
      deadlineTs: 60_000,
    };
    await gateway.complete(request, runContext);

    await expect(gateway.complete(request, runContext)).rejects.toMatchObject({
      code: "deadline_exceeded",
    });
    expect(complete).toHaveBeenCalledOnce();
  });

  it("maps invalid adapter output to provider_unknown without metadata", async () => {
    const adapter: ProviderAdapter = {
      provider: "sample",
      kind: "openai",
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
    const gateway = new ModelGateway(new AdapterRegistry([providerAdapter("openai", complete)]), {
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

  it("uses a value transform and keeps the tokenized result in the gateway response", async () => {
    const tokenized: JsonValueType = { email: "<EMAIL_1>" };
    const raw = { email: "alice@example.test" };
    const complete = vi.fn(() =>
      Promise.resolve({
        parts: [{ type: "text" as const, text: JSON.stringify(tokenized) }],
        usage: { inputTokens: 1, outputTokens: 1 },
        finishReason: "stop",
        latencyMs: 1,
      }),
    );
    const gateway = new ModelGateway(new AdapterRegistry([providerAdapter("openai", complete)]), {
      ids: { next: () => request.requestId },
      clock: { now: () => 0 },
    });
    const outputSchema = z.object({ email: z.string().email() });
    let transformedValue: JsonValueType | undefined;
    const valueTransform: ValueTransform = async (schema, value) => {
      transformedValue = value;
      if (!schema.safeParse(raw).success) {
        return { ok: false, issues: [{ path: ["email"], code: "invalid_format" }] };
      }
      return { ok: true, tokenized: value };
    };

    const completion = await gateway.complete(
      { ...request, model: { provider: "openai", model: "model-a" } },
      {
        runId: request.requestId,
        signal: new AbortController().signal,
        outputSchema,
        valueTransform,
      },
    );

    expect(transformedValue).toEqual(tokenized);
    expect(completion).toMatchObject({
      parts: [{ type: "text", text: '{"email":"<EMAIL_1>"}' }],
      schemaValid: true,
      enforcement: { valid: true, value: tokenized },
    });
    expect(JSON.stringify(completion)).not.toContain("alice@example.test");
  });

  it("repairs unresolvable tokens from paths only", async () => {
    const tokenized: JsonValueType = { email: "<EMAIL_9>" };
    const complete = vi.fn(() =>
      Promise.resolve({
        parts: [{ type: "text" as const, text: JSON.stringify(tokenized) }],
        usage: { inputTokens: 1, outputTokens: 1 },
        finishReason: "stop",
        latencyMs: 1,
      }),
    );
    const gateway = new ModelGateway(new AdapterRegistry([providerAdapter("openai", complete)]), {
      ids: { next: () => request.requestId },
      clock: { now: () => 0 },
      enforcement: { maxRepairs: 1 },
    });
    let validationAttempts = 0;
    const valueTransform: ValueTransform = async (_schema, value) => {
      validationAttempts += 1;
      return validationAttempts === 1
        ? { ok: false, issues: [{ path: ["email"], code: "pii_token_unresolvable" }] }
        : { ok: true, tokenized: value };
    };

    const completion = await gateway.complete(
      { ...request, model: { provider: "openai", model: "model-a" } },
      {
        runId: request.requestId,
        signal: new AbortController().signal,
        outputSchema: z.object({ email: z.string().email() }),
        valueTransform,
      },
    );

    const repair = complete.mock.calls[1]?.[0].messages.at(-1);
    expect(repair).toMatchObject({
      role: "user",
      parts: [
        {
          type: "text",
          text: "Correct the structured output to match the requested schema. Return only the corrected output.\n$.email: expected a value matching the requested schema",
        },
      ],
    });
    expect(JSON.stringify(repair)).not.toContain("<EMAIL_9>");
    expect(completion.parts).toEqual([{ type: "text", text: '{"email":"<EMAIL_9>"}' }]);
  });

  it("uses built-in protocol behavior for a custom adapter id", async () => {
    let requestBody: JsonValue | undefined;
    const adapter = new OpenAIAdapter({
      apiKey: { reveal: () => "synthetic-test-key" },
      provider: "openai_eu",
      fetch: (_input, init) => {
        if (typeof init?.body === "string") {
          requestBody = parseJson(JsonValue, init.body);
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: "completion-test",
              object: "chat.completion",
              created: 1,
              model: "gpt-test",
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: '{"answer":"ok"}' },
                  finish_reason: "stop",
                },
              ],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      },
    });
    const gateway = new ModelGateway(new AdapterRegistry([adapter]), {
      ids: { next: () => request.requestId },
      clock: { now: () => 0 },
    });

    const completion = await gateway.complete(
      { ...request, model: { provider: "openai_eu", model: "gpt-test" } },
      {
        runId: request.requestId,
        signal: new AbortController().signal,
        outputSchema: z.object({ answer: z.string() }).strict(),
      },
    );

    expect(adapter.kind).toBe("openai");
    expect(requestBody).toMatchObject({
      response_format: {
        type: "json_schema",
        json_schema: {
          schema: {
            additionalProperties: false,
            required: ["answer"],
          },
        },
      },
    });
    expect(completion).toMatchObject({ provider: "openai_eu", rungUsed: "native" });
  });

  it("throws a value-free error when native output remains invalid after the repair limit", async () => {
    const complete = vi.fn(() =>
      Promise.resolve({
        parts: [{ type: "text" as const, text: '{"answer":"private response"}' }],
        usage: { inputTokens: 1, outputTokens: 1 },
        finishReason: "stop",
        latencyMs: 1,
      }),
    );
    const adapter: ProviderAdapter = {
      provider: "openai",
      kind: "openai",
      complete,
    };
    const gateway = new ModelGateway(new AdapterRegistry([adapter]), {
      ids: { next: () => request.requestId },
      clock: { now: () => 0 },
      enforcement: { maxRepairs: 0 },
    });
    const error = await gateway
      .complete(
        { ...request, model: { provider: "openai", model: "model-a" } },
        {
          runId: request.requestId,
          signal: new AbortController().signal,
          outputSchema: z.object({ answer: z.number() }),
        },
      )
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );

    expect(error).toBeInstanceOf(ModelOutputInvalidError);
    expect(error).toMatchObject({
      code: "model_output_invalid",
      repairAttempts: 0,
      issuePaths: [["answer"]],
    });
    expect(JSON.stringify(error)).not.toContain("private response");
    expect(complete).toHaveBeenCalledOnce();
  });

  it("redacts model-provided record keys from exhausted-output errors", async () => {
    const canary = "alice@example.test";
    const complete = vi.fn(() =>
      Promise.resolve({
        parts: [{ type: "text" as const, text: `{"${canary}":"invalid"}` }],
        usage: { inputTokens: 1, outputTokens: 1 },
        finishReason: "stop",
        latencyMs: 1,
      }),
    );
    const gateway = new ModelGateway(
      new AdapterRegistry([providerAdapter("sample", complete, "anthropic")]),
      {
        ids: { next: () => request.requestId },
        clock: { now: () => 0 },
        enforcement: { maxRepairs: 0 },
      },
    );
    const error = await gateway
      .complete(
        { ...request, model: { provider: "sample", model: "model-a" } },
        {
          runId: request.requestId,
          signal: new AbortController().signal,
          outputSchema: z.record(z.string(), z.number()),
        },
      )
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );

    expect(error).toBeInstanceOf(ModelOutputInvalidError);
    expect(JSON.stringify(error)).not.toContain(canary);
  });

  it("repairs invalid output once and aggregates usage while keeping the selected rung", async () => {
    const seenRequests: ModelRequest[] = [];
    let calls = 0;
    const complete = vi.fn((providerRequest: ModelRequest) => {
      seenRequests.push(providerRequest);
      calls += 1;
      return Promise.resolve(
        calls === 1
          ? {
              parts: [{ type: "text" as const, text: '{"items":[{"count":"CANARY_VALUE"}]}' }],
              usage: { inputTokens: 2, outputTokens: 3, costMicros: 5 },
              finishReason: "stop",
              latencyMs: 7,
            }
          : {
              parts: [{ type: "text" as const, text: '{"items":[{"count":4}]}' }],
              usage: { inputTokens: 11, outputTokens: 13, costMicros: 17 },
              finishReason: "stop",
              latencyMs: 19,
            },
      );
    });
    const gateway = new ModelGateway(new AdapterRegistry([providerAdapter("openai", complete)]), {
      ids: { next: () => request.requestId },
      clock: { now: () => 0 },
      pricing: {
        "openai/model-a": { inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 1_000_000 },
      },
    });
    const completion = await gateway.complete(
      { ...request, model: { provider: "openai", model: "model-a" } },
      {
        runId: request.requestId,
        signal: new AbortController().signal,
        outputSchema: z.object({ items: z.array(z.object({ count: z.number().int() })) }),
      },
    );
    const repairMessage = seenRequests[1]?.messages.at(-1);

    expect(complete).toHaveBeenCalledTimes(2);
    expect(seenRequests[1]?.output).toEqual(seenRequests[0]?.output);
    expect(repairMessage).toMatchObject({
      role: "user",
      parts: [
        {
          type: "text",
          text: "Correct the structured output to match the requested schema. Return only the corrected output.\n$.items[0].count: expected number",
        },
      ],
    });
    expect(JSON.stringify(repairMessage)).not.toContain("CANARY_VALUE");
    expect(seenRequests[1]?.messages.at(-2)).toEqual({
      role: "assistant",
      parts: [{ type: "text", text: '{"items":[{"count":"CANARY_VALUE"}]}' }],
    });
    expect(completion).toMatchObject({
      schemaValid: true,
      repairAttempts: 1,
      usage: { inputTokens: 13, outputTokens: 16, costMicros: 29 },
      latencyMs: 26,
    });
  });

  it.each(["anthropic", "openai"] as const)(
    "repairs tool-rung output with a structurally valid %s conversation",
    async (provider) => {
      const requestBodies: JsonValue[] = [];
      let calls = 0;
      const responseFetch: typeof fetch = (_input, init) => {
        if (typeof init?.body === "string") {
          requestBodies.push(parseJson(JsonValue, init.body));
        }
        calls += 1;
        const input = calls === 1 ? { answer: "invalid" } : { answer: 1 };
        const body =
          provider === "anthropic"
            ? {
                id: `message-${String(calls)}`,
                type: "message",
                role: "assistant",
                model: "claude-test",
                content: [
                  {
                    type: "tool_use",
                    id: calls === 1 ? "toolu_invalid" : "toolu_valid",
                    name: "emit_result",
                    input,
                  },
                ],
                stop_reason: "tool_use",
                stop_sequence: null,
                usage: { input_tokens: 2, output_tokens: 3 },
              }
            : {
                id: `completion-${String(calls)}`,
                object: "chat.completion",
                created: 1,
                model: "gpt-test",
                choices: [
                  {
                    index: 0,
                    message: {
                      role: "assistant",
                      content: null,
                      tool_calls: [
                        {
                          id: calls === 1 ? "call_invalid" : "call_valid",
                          type: "function",
                          function: { name: "emit_result", arguments: JSON.stringify(input) },
                        },
                      ],
                    },
                    finish_reason: "tool_calls",
                  },
                ],
                usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
              };
        return Promise.resolve(
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      };
      const adapter =
        provider === "anthropic"
          ? new AnthropicAdapter({
              apiKey: { reveal: () => "synthetic-test-key" },
              fetch: responseFetch,
              baseURL: "https://provider.test",
            })
          : new OpenAIAdapter({
              apiKey: { reveal: () => "synthetic-test-key" },
              fetch: responseFetch,
              baseURL: "https://provider.test/v1",
              capabilities: { structuredOutput: "none", forcedToolChoice: true },
            });
      const gateway = new ModelGateway(new AdapterRegistry([adapter]), {
        ids: { next: () => request.requestId },
        clock: { now: () => 0 },
      });
      const completion = await gateway.complete(
        {
          ...request,
          model: { provider, model: provider === "anthropic" ? "claude-test" : "gpt-test" },
          maxOutputTokens: 32,
        },
        {
          runId: request.requestId,
          signal: new AbortController().signal,
          outputSchema: z.object({ answer: z.number() }),
        },
      );

      expect(completion).toMatchObject({ schemaValid: true, repairAttempts: 1 });
      expect(requestBodies).toHaveLength(2);
      const assertRepairBody =
        provider === "anthropic" ? expectAnthropicRepairBody : expectOpenAiRepairBody;
      assertRepairBody(requestBodies[1]);
    },
  );

  it("drops malformed opaque OpenAI tool calls before tool-rung repair", async () => {
    const requestBodies: JsonValue[] = [];
    let calls = 0;
    const responseFetch: typeof fetch = (_input, init) => {
      if (typeof init?.body === "string") {
        requestBodies.push(parseJson(JsonValue, init.body));
      }
      calls += 1;
      const body = {
        id: `completion-${String(calls)}`,
        object: "chat.completion",
        created: 1,
        model: "gpt-test",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_malformed",
                  type: "function",
                  function: {
                    name: "emit_result",
                    arguments: calls === 1 ? "not-json" : '{"answer":1}',
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
      };
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    };
    const adapter = new OpenAIAdapter({
      apiKey: { reveal: () => "synthetic-test-key" },
      fetch: responseFetch,
      baseURL: "https://provider.test/v1",
      capabilities: { structuredOutput: "none", forcedToolChoice: true },
    });
    const gateway = new ModelGateway(new AdapterRegistry([adapter]), {
      ids: { next: () => request.requestId },
      clock: { now: () => 0 },
    });
    const completion = await gateway.complete(
      {
        ...request,
        model: { provider: "openai", model: "gpt-test" },
      },
      {
        runId: request.requestId,
        signal: new AbortController().signal,
        outputSchema: z.object({ answer: z.number() }),
      },
    );

    expect(completion).toMatchObject({ schemaValid: true, repairAttempts: 1 });
    expect(requestBodies[1]).toMatchObject({
      messages: [
        { role: "user", content: "hello" },
        {
          role: "user",
          content:
            "Correct the structured output to match the requested schema. Return only the corrected output.\n$: expected a value matching the requested schema",
        },
      ],
    });
    expect(JSON.stringify(requestBodies[1])).not.toContain("call_malformed");
  });

  it("omits aggregate cost when any completed repair attempt does not report cost", async () => {
    let calls = 0;
    const complete = vi.fn(() => {
      calls += 1;
      return Promise.resolve({
        parts: [{ type: "text" as const, text: calls === 1 ? '{"answer":"bad"}' : '{"answer":1}' }],
        usage:
          calls === 1
            ? { inputTokens: 1, outputTokens: 1 }
            : { inputTokens: 2, outputTokens: 3, costMicros: 7 },
        finishReason: "stop",
        latencyMs: 1,
      });
    });
    const gateway = new ModelGateway(new AdapterRegistry([providerAdapter("openai", complete)]), {
      ids: { next: () => request.requestId },
      clock: { now: () => 0 },
    });
    const completion = await gateway.complete(
      { ...request, model: { provider: "openai", model: "model-a" } },
      {
        runId: request.requestId,
        signal: new AbortController().signal,
        outputSchema: z.object({ answer: z.number() }),
      },
    );

    expect(completion.usage).toEqual({ inputTokens: 3, outputTokens: 4 });
    expect(completion.usage).not.toHaveProperty("costMicros");
  });

  it("stops after the configured number of repair calls and reports final issue paths", async () => {
    const complete = vi.fn(() =>
      Promise.resolve({
        parts: [{ type: "text" as const, text: '{"answer":false}' }],
        usage: { inputTokens: 1, outputTokens: 1 },
        finishReason: "stop",
        latencyMs: 1,
      }),
    );
    const gateway = new ModelGateway(new AdapterRegistry([providerAdapter("openai", complete)]), {
      ids: { next: () => request.requestId },
      clock: { now: () => 0 },
      enforcement: { maxRepairs: 2 },
    });

    const error = await gateway
      .complete(
        { ...request, model: { provider: "openai", model: "model-a" } },
        {
          runId: request.requestId,
          signal: new AbortController().signal,
          outputSchema: z.object({ answer: z.number() }),
        },
      )
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );

    expect(complete).toHaveBeenCalledTimes(3);
    expect(error).toMatchObject({
      code: "model_output_invalid",
      repairAttempts: 2,
      issuePaths: [["answer"]],
    });
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
    const gateway = new ModelGateway(
      new AdapterRegistry([providerAdapter("anthropic", complete, "anthropic")]),
      {
        ids: { next: () => request.requestId },
        clock: { now: () => 0 },
      },
    );
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

  it("falls back to prompt validation when native output and forced tools are unavailable", async () => {
    const fake = new FakeProvider("openai", [
      {
        parts: [{ type: "text", text: 'Answer: {"answer":"ok"}' }],
        usage: { inputTokens: 2, outputTokens: 3 },
        finishReason: "stop",
        latencyMs: 7,
      },
    ]);
    const adapter: ProviderAdapter = {
      provider: "openai",
      kind: "openai",
      capabilities: { structuredOutput: "none", forcedToolChoice: false },
      complete: (providerRequest, providerContext) =>
        fake.complete(providerRequest, providerContext),
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
        outputSchema: z.object({ answer: z.string() }).strict(),
      },
    );

    const systemInstruction = fake.requests[0]?.messages[0]?.parts[0];
    expect(systemInstruction?.type).toBe("text");
    const instructionText = systemInstruction?.type === "text" ? systemInstruction.text : "";
    expect(instructionText).toContain('"properties":{"answer":{"type":"string"}}');
    expect(completion).toMatchObject({
      schemaValid: true,
      rungUsed: "prompt",
      enforcement: { valid: true, value: { answer: "ok" }, rungUsed: "prompt" },
    });
  });

  it("throws a safe validation error for invalid prompt output when repairs are disabled", async () => {
    const fake = new FakeProvider("openai", [
      {
        parts: [{ type: "text", text: '{"answer":"private response"}' }],
        usage: { inputTokens: 0, outputTokens: 0 },
        finishReason: "stop",
        latencyMs: 0,
      },
    ]);
    const adapter: ProviderAdapter = {
      provider: "openai",
      kind: "openai",
      capabilities: { structuredOutput: "none", forcedToolChoice: false },
      complete: (providerRequest, providerContext) =>
        fake.complete(providerRequest, providerContext),
    };
    const gateway = new ModelGateway(new AdapterRegistry([adapter]), {
      ids: { next: () => request.requestId },
      clock: { now: () => 0 },
      enforcement: { maxRepairs: 0 },
    });
    const error = await gateway
      .complete(
        { ...request, model: { provider: "openai", model: "model-a" } },
        {
          runId: request.requestId,
          signal: new AbortController().signal,
          outputSchema: z.object({ answer: z.number() }).strict(),
        },
      )
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );

    expect(error).toMatchObject({
      code: "model_output_invalid",
      repairAttempts: 0,
      issuePaths: [["answer"]],
    });
    expect(JSON.stringify(error)).not.toContain("private response");
  });

  it("selects prompt validation for providers without native output support", async () => {
    const complete = vi.fn((_providerRequest: ModelRequest) =>
      Promise.resolve({
        parts: [{ type: "text" as const, text: '{"answer":"ok"}' }],
        usage: { inputTokens: 0, outputTokens: 0 },
        finishReason: "stop",
        latencyMs: 0,
      }),
    );
    const adapter: ProviderAdapter = {
      provider: "unknown_provider",
      kind: "openai",
      capabilities: { structuredOutput: "none", forcedToolChoice: false },
      complete,
    };
    const gateway = new ModelGateway(new AdapterRegistry([adapter]), {
      ids: { next: () => request.requestId },
      clock: { now: () => 0 },
    });
    const outputSchema = z.object({ answer: z.string().default("ok") });
    const completion = await gateway.complete(
      { ...request, model: { provider: "unknown_provider", model: "model-a" } },
      {
        runId: request.requestId,
        signal: new AbortController().signal,
        outputSchema,
      },
    );

    expect(complete.mock.calls[0]?.[0].output?.schema).toBeDefined();
    expect(completion).toMatchObject({
      schemaValid: true,
      rungUsed: "prompt",
      enforcement: { valid: true, value: { answer: "ok" } },
    });
  });

  it("uses prompt validation when the request caps the enforcement rung", async () => {
    const adapter: ProviderAdapter = {
      provider: "unknown_provider",
      kind: "openai",
      capabilities: { structuredOutput: "none", forcedToolChoice: false },
      complete: () =>
        Promise.resolve({
          parts: [{ type: "text", text: '{"answer":"ok"}' }],
          usage: { inputTokens: 0, outputTokens: 0 },
          finishReason: "stop",
          latencyMs: 0,
        }),
    };
    const gateway = new ModelGateway(
      new AdapterRegistry([adapter]),
      { ids: { next: () => request.requestId }, clock: { now: () => 0 } },
      { maxRung: "prompt" },
    );

    const completion = await gateway.complete(
      { ...request, model: { provider: "unknown_provider", model: "model-a" } },
      {
        runId: request.requestId,
        signal: new AbortController().signal,
        outputSchema: z.object({ answer: z.string() }),
      },
    );

    expect(completion.rungUsed).toBe("prompt");
  });

  it("rejects unexpected tool calls returned by the prompt rung", async () => {
    const adapter: ProviderAdapter = {
      provider: "openai",
      kind: "openai",
      capabilities: { structuredOutput: "none", forcedToolChoice: false },
      complete: () =>
        Promise.resolve({
          parts: [
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
      enforcement: { maxRepairs: 0 },
    });
    const error = await gateway
      .complete(
        { ...request, model: { provider: "openai", model: "model-a" } },
        {
          runId: request.requestId,
          signal: new AbortController().signal,
          outputSchema: z.object({ answer: z.string() }),
        },
      )
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );

    expect(error).toMatchObject({ code: "model_output_invalid", issuePaths: [[]] });
  });

  it("rejects native output that also contains tool calls", async () => {
    const adapter: ProviderAdapter = {
      provider: "openai",
      kind: "openai",
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
      enforcement: { maxRepairs: 0 },
    });
    const error = await gateway
      .complete(
        { ...request, model: { provider: "openai", model: "model-a" } },
        {
          runId: request.requestId,
          signal: new AbortController().signal,
          outputSchema: z.object({ answer: z.string() }),
        },
      )
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );

    expect(error).toMatchObject({ code: "model_output_invalid", issuePaths: [[]] });
  });

  it("rejects structured output combined with real tools", async () => {
    const adapter: ProviderAdapter = {
      provider: "openai",
      kind: "openai",
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

  it("rejects when maxRung excludes the available enforcement rung", async () => {
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
      kind: "openai",
      capabilities: { structuredOutput: "none", forcedToolChoice: false },
      complete,
    };
    const gateway = new ModelGateway(
      new AdapterRegistry([adapter]),
      {
        ids: { next: () => request.requestId },
        clock: { now: () => 0 },
      },
      { maxRung: "tool" },
    );

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
