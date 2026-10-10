// SPDX-License-Identifier: Apache-2.0
import {
  Code,
  ModelRetryConfigSchema,
  type Id,
  type JsonValue,
  type ModelRequest,
  type ModelResponse,
  type ModelRetryConfig,
} from "@harness/schemas";
import { setActiveSpanAttribute } from "@harness/telemetry";
import { ProviderResultSchema, type Clock, type IdGenerator } from "./types.js";
import type { AdapterRegistry } from "./registry.js";
import { ProviderError } from "./errors.js";
import { TokenBucketRateLimiter } from "./resilience/limiter.js";
import { abortableSleep, withRetries, type Random, type Sleep } from "./resilience/retry.js";
import { Semaphore } from "./resilience/semaphore.js";

/** Dependencies injected into every provider adapter call by the gateway. */
export interface ModelGatewayDependencies {
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly retryPolicy?: ModelRetryConfig;
  readonly random?: Random;
  readonly sleep?: Sleep;
  readonly requestsPerMinute?: Readonly<Partial<Record<Code, number>>>;
  readonly maxConcurrent?: number;
}

/** Minimal provider-selecting model port implementation. */
export class ModelGateway {
  private readonly retryPolicy: ModelRetryConfig;
  private readonly random: Random;
  private readonly sleep: Sleep;
  private readonly maxConcurrent: number;
  private readonly limiters = new Map<Code, TokenBucketRateLimiter>();
  private readonly semaphores = new Map<Code, Semaphore>();

  /**
   * @param registry - Provider adapters available for requests.
   * @param dependencies - Deterministic runtime dependencies forwarded to adapters.
   */
  constructor(
    private readonly registry: AdapterRegistry,
    private readonly dependencies: ModelGatewayDependencies,
  ) {
    this.retryPolicy = ModelRetryConfigSchema.parse(
      dependencies.retryPolicy ?? ModelRetryConfigSchema.parse({}),
    );
    this.random = dependencies.random ?? Math.random;
    this.sleep = dependencies.sleep ?? abortableSleep;
    this.maxConcurrent = dependencies.maxConcurrent ?? 4;
    if (!Number.isSafeInteger(this.maxConcurrent) || this.maxConcurrent < 1) {
      throw new RangeError("maxConcurrent must be a positive integer.");
    }
    for (const [provider, requestsPerMinute] of Object.entries(
      dependencies.requestsPerMinute ?? {},
    )) {
      if (requestsPerMinute === undefined) {
        continue;
      }
      this.limiters.set(
        Code.parse(provider),
        new TokenBucketRateLimiter(requestsPerMinute, dependencies.clock, this.sleep),
      );
    }
  }

  /**
   * Completes a request through the adapter selected by its provider code.
   *
   * @param request - Normalized provider-neutral request.
   * @param context - Run identifier, cancellation signal, and optional budget deadline.
   * @returns A minimal model-port completion without repair or fallback.
   */
  async complete(
    request: ModelRequest,
    context: { readonly runId: Id; readonly signal: AbortSignal; readonly deadlineTs?: number },
  ): Promise<ModelResponse & { readonly providerBlobs: JsonValue }> {
    const adapter = this.registry.get(request.model.provider);
    const limiter = this.limiters.get(adapter.provider);
    let semaphore = this.semaphores.get(adapter.provider);
    if (semaphore === undefined) {
      semaphore = new Semaphore(this.maxConcurrent);
      this.semaphores.set(adapter.provider, semaphore);
    }
    let attempts = 0;
    const adapterResult = await withRetries({
      policy: this.retryPolicy,
      clock: this.dependencies.clock,
      random: this.random,
      sleep: this.sleep,
      signal: context.signal,
      ...(context.deadlineTs === undefined ? {} : { deadlineTs: context.deadlineTs }),
      scheduleAttempt: async (signal, lastError, operation) => {
        if (limiter !== undefined) {
          await limiter.acquire(signal, context.deadlineTs, lastError);
        }
        return semaphore.run(signal, operation);
      },
      operation: (signal) => {
        attempts += 1;
        setActiveSpanAttribute("harness.model.attempts", attempts);
        return adapter.complete(request, {
          signal,
          ids: this.dependencies.ids,
          clock: this.dependencies.clock,
          ...(context.deadlineTs === undefined ? {} : { deadlineTs: context.deadlineTs }),
        });
      },
    });
    const parsedResult = ProviderResultSchema.safeParse(adapterResult);
    if (!parsedResult.success) {
      throw new ProviderError("provider_unknown");
    }
    const result = parsedResult.data;

    return {
      parts: result.parts,
      usage: result.usage,
      finishReason: result.finishReason,
      provider: adapter.provider,
      model: request.model.model,
      latencyMs: result.latencyMs,
      schemaValid: true,
      repairAttempts: 0,
      fallbackDepth: 0,
      providerBlobs: null,
    };
  }
}
