// SPDX-License-Identifier: Apache-2.0
import {
  Code,
  lookupCapabilities,
  ModelEnforcementConfigSchema,
  ModelRetryConfigSchema,
  type ModelRef,
  type ModelRequest,
  type ModelUsage,
  type ModelRetryConfig,
} from "@rovinos/schemas";
import {
  emitPricingCacheMissing,
  emitPricingMissing,
  setActiveSpanAttribute,
} from "@rovinos/telemetry";
import type { z } from "zod";
import type { ProviderAdapter } from "./types.js";
import { collectProviderStream } from "./streaming.js";
import type { AdapterRegistry } from "./registry.js";
import { readModelFailureMetadata } from "./errors.js";
import { TokenBucketRateLimiter } from "./resilience/limiter.js";
import { abortableSleep, withRetries, type Random, type Sleep } from "./resilience/retry.js";
import { Semaphore } from "./resilience/semaphore.js";
import {
  enforceProviderOutput,
  prepareProviderResult,
  prepareEnforcementRequest,
} from "./enforce/provider-output.js";
import { awaitRunValidation } from "./enforce/validation-deadline.js";
import { createPricingAccountant } from "./pricing.js";
import { aggregateModelUsage, reportModelUsage } from "./usage.js";
import { prepareProviderRequest } from "./provider-request.js";
import { appendRepairOrThrow, rethrowWithAccountedUsage } from "./gateway-failure.js";
import type {
  AnyModelGatewayResponse,
  ModelGatewayContext,
  ModelGatewayContextBase,
  ModelGatewayDependencies,
  ModelGatewayOptions,
  ModelGatewayResponse,
  PreparedCompletionOptions,
  TokenizedModelGatewayContext,
  TokenizedModelGatewayResponse,
} from "./gateway-types.js";

export type {
  ModelGatewayContext,
  ModelGatewayDependencies,
  ModelGatewayOptions,
  ModelGatewayResponse,
  RequestSanitizer,
  TokenizedModelGatewayContext,
  TokenizedModelGatewayResponse,
} from "./gateway-types.js";

function validateGatewayOutput(options: {
  readonly parts: ModelGatewayResponse["parts"];
  readonly context: ModelGatewayContext;
  readonly prepared: PreparedCompletionOptions<z.ZodType>["prepared"];
  readonly clock: ModelGatewayDependencies["clock"];
}) {
  return awaitRunValidation(
    () => enforceProviderOutput(options.parts, options.context, options.prepared.rung),
    options.context,
    options.clock,
  );
}

function prepareResult(
  result: unknown,
  adapter: ProviderAdapter,
  prepared: PreparedCompletionOptions<z.ZodType>["prepared"],
) {
  return prepareProviderResult(result, adapter.kind, prepared.droppedSchemaKeywords);
}

function requestOutputRepair(options: {
  readonly request: ModelRequest;
  readonly parts: ModelGatewayResponse["parts"];
  readonly enforcement: Awaited<ReturnType<typeof enforceProviderOutput>>["result"];
  readonly repairAttempts: number;
  readonly maxRepairs: number;
  readonly usage: ModelUsage | undefined;
  readonly latencyMs: number;
}): ModelRequest | undefined {
  const enforcement = options.enforcement;
  if (enforcement === undefined || !("issues" in enforcement)) {
    return undefined;
  }
  return appendRepairOrThrow({
    currentRequest: options.request,
    parts: options.parts,
    issues: enforcement.issues,
    ...(enforcement.rungUsed === undefined ? {} : { rungUsed: enforcement.rungUsed }),
    outputSchema: options.request.output?.schema,
    repairAttempts: options.repairAttempts,
    maxRepairs: options.maxRepairs,
    usage: options.usage,
    latencyMs: options.latencyMs,
  });
}

function recordAttempt(attempts: number): void {
  setActiveSpanAttribute("harness.model.attempts", attempts);
}

function failedAttemptTotals(
  error: unknown,
  usage: ModelUsage | undefined,
  latencyMs: number,
): { readonly usage: ModelUsage | undefined; readonly latencyMs: number } {
  const metadata = readModelFailureMetadata(error);
  return {
    usage: metadata.usage === undefined ? usage : aggregateModelUsage(usage, metadata.usage),
    latencyMs: latencyMs + (metadata.latencyMs ?? 0),
  };
}

/** Minimal provider-selecting model port implementation. */
export class ModelGateway {
  private readonly retryPolicy: ModelRetryConfig;
  private readonly random: Random;
  private readonly sleep: Sleep;
  private readonly maxConcurrent: number;
  private readonly maxRepairs: number;
  private readonly limiters = new Map<Code, TokenBucketRateLimiter>();
  private readonly semaphores = new Map<Code, Semaphore>();
  private readonly accountUsage: (model: ModelRef, usage: ModelUsage) => ModelUsage;

  /**
   * @param registry - Provider adapters available for requests.
   * @param dependencies - Deterministic runtime dependencies forwarded to adapters.
   */
  constructor(
    private readonly registry: AdapterRegistry,
    private readonly dependencies: ModelGatewayDependencies,
    private readonly options: ModelGatewayOptions = {},
  ) {
    this.accountUsage = createPricingAccountant(
      dependencies.pricing,
      (model) => {
        emitPricingMissing(model.provider, model.model);
      },
      (model) => {
        emitPricingCacheMissing(model.provider, model.model);
      },
    );
    this.retryPolicy = ModelRetryConfigSchema.parse(
      dependencies.retryPolicy ?? ModelRetryConfigSchema.parse({}),
    );
    this.random = dependencies.random ?? Math.random;
    this.sleep = dependencies.sleep ?? abortableSleep;
    this.maxConcurrent = dependencies.maxConcurrent ?? 4;
    this.maxRepairs = ModelEnforcementConfigSchema.parse(dependencies.enforcement ?? {}).maxRepairs;
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

  private completeWithRetries(
    adapter: ProviderAdapter,
    options: {
      readonly request: ModelRequest;
      readonly context: ModelGatewayContext;
      readonly limiter: TokenBucketRateLimiter | undefined;
      readonly semaphore: Semaphore;
      readonly onAttempt: () => void;
      readonly onFailedAttempt: (error: unknown) => void;
    },
  ) {
    const { request, context, limiter, semaphore, onAttempt, onFailedAttempt } = options;
    const stream = adapter.stream?.bind(adapter);
    const useStream =
      stream !== undefined && this.dependencies.providerStreaming?.[adapter.provider] !== false;
    return withRetries({
      policy: this.retryPolicy,
      clock: this.dependencies.clock,
      random: this.random,
      sleep: this.sleep,
      signal: context.signal,
      ...(useStream ? { attemptTimeoutMs: this.retryPolicy.streamTimeoutMs } : {}),
      ...(context.deadlineTs === undefined ? {} : { deadlineTs: context.deadlineTs }),
      prepareAttempt: async (signal, lastError) => {
        if (limiter !== undefined) {
          await limiter.acquire(signal, context.deadlineTs, lastError);
        }
        return semaphore.acquire(signal);
      },
      operation: async (signal) => {
        onAttempt();
        try {
          const sanitizedRequest = await prepareProviderRequest({
            request,
            provider: adapter.provider,
            trust: this.dependencies.providerTrust?.[adapter.provider] ?? "hosted",
            context,
            sanitizer: this.dependencies.requestSanitizer,
            signal,
          });
          signal.throwIfAborted();
          const providerContext = {
            signal,
            ids: this.dependencies.ids,
            clock: this.dependencies.clock,
            ...(useStream ? { idleTimeoutMs: this.retryPolicy.idleTimeoutMs } : {}),
            ...(context.deadlineTs === undefined ? {} : { deadlineTs: context.deadlineTs }),
          };
          if (useStream) {
            return await collectProviderStream({
              stream: (streamSignal) =>
                stream(sanitizedRequest, {
                  ...providerContext,
                  signal: streamSignal,
                }),
              signal,
              idleTimeoutMs: this.retryPolicy.idleTimeoutMs,
              requestId: sanitizedRequest.requestId,
              ...(context.onProgress === undefined ? {} : { onProgress: context.onProgress }),
            });
          }
          return await adapter.complete(sanitizedRequest, providerContext);
        } catch (error) {
          onFailedAttempt(error);
          throw error;
        }
      },
    });
  }

  private async completePrepared<OutputSchema extends z.ZodType>(
    options: PreparedCompletionOptions<OutputSchema>,
  ): Promise<AnyModelGatewayResponse<OutputSchema>> {
    const { request, context, adapter, prepared, limiter, semaphore } = options;
    let attempts = 0;
    let repairAttempts = 0;
    let aggregateUsage: ModelUsage | undefined;
    let aggregateLatencyMs = 0;
    let currentRequest = prepared.request;
    try {
      for (;;) {
        setActiveSpanAttribute("harness.model.repair_attempts", repairAttempts);
        const adapterResult = await this.completeWithRetries(adapter, {
          request: currentRequest,
          context,
          limiter,
          semaphore,
          onAttempt: () => {
            recordAttempt(++attempts);
          },
          onFailedAttempt: (error) => {
            const totals = failedAttemptTotals(error, aggregateUsage, aggregateLatencyMs);
            aggregateUsage = totals.usage;
            aggregateLatencyMs = totals.latencyMs;
          },
        });
        const result = prepareResult(adapterResult, adapter, prepared);
        aggregateUsage = aggregateModelUsage(aggregateUsage, result.usage);
        aggregateLatencyMs += result.latencyMs;

        const enforced = await validateGatewayOutput({
          parts: result.parts,
          context,
          prepared,
          clock: this.dependencies.clock,
        });
        const enforcement = enforced.result;
        const repairRequest = requestOutputRepair({
          request: currentRequest,
          parts: result.parts,
          enforcement,
          repairAttempts,
          maxRepairs: this.maxRepairs,
          usage: aggregateUsage,
          latencyMs: aggregateLatencyMs,
        });
        if (repairRequest !== undefined) {
          currentRequest = repairRequest;
          repairAttempts += 1;
          continue;
        }

        const usage = this.accountUsage(request.model, aggregateUsage);
        reportModelUsage(request.model, usage, this.options.deferSpanUsage === true);
        return {
          parts: enforced.parts,
          usage,
          finishReason: result.finishReason,
          provider: adapter.provider,
          model: request.model.model,
          latencyMs: aggregateLatencyMs,
          schemaValid: enforcement?.valid ?? true,
          repairAttempts,
          ...(enforcement === undefined ? {} : { enforcement }),
          ...(enforcement?.rungUsed === undefined ? {} : { rungUsed: enforcement.rungUsed }),
          fallbackDepth: 0,
          providerBlobs: null,
        };
      }
    } catch (error) {
      rethrowWithAccountedUsage({
        error,
        model: request.model,
        usage: aggregateUsage,
        latencyMs: aggregateLatencyMs,
        repairAttempts,
        deferUsage: this.options.deferSpanUsage === true,
        accountUsage: this.accountUsage,
      });
    }
  }

  /**
   * Completes a request through the adapter selected by its provider code.
   *
   * @param request - Normalized provider-neutral request.
   * @param context - Run identifier, cancellation signal, optional deadline, and output schema.
   * @returns Provider completion with validation details when output enforcement is requested.
   */
  complete<OutputSchema extends z.ZodType = z.ZodType>(
    request: ModelRequest,
    context: ModelGatewayContextBase<OutputSchema> & {
      readonly valueTransform?: undefined;
    },
  ): Promise<ModelGatewayResponse<OutputSchema>>;
  complete<OutputSchema extends z.ZodType = z.ZodType>(
    request: ModelRequest,
    context: TokenizedModelGatewayContext<OutputSchema>,
  ): Promise<TokenizedModelGatewayResponse>;
  complete<OutputSchema extends z.ZodType = z.ZodType>(
    request: ModelRequest,
    context: ModelGatewayContext<OutputSchema>,
  ): Promise<AnyModelGatewayResponse<OutputSchema>>;
  async complete<OutputSchema extends z.ZodType = z.ZodType>(
    request: ModelRequest,
    context: ModelGatewayContext<OutputSchema>,
  ): Promise<AnyModelGatewayResponse<OutputSchema>> {
    const adapter = this.registry.get(request.model.provider);
    const effectiveRequest =
      request.maxOutputTokens === undefined
        ? {
            ...request,
            maxOutputTokens: adapter.maxOutputTokens ?? 4_096,
          }
        : request;
    const prepared =
      context.outputSchema === undefined
        ? { request: effectiveRequest }
        : prepareEnforcementRequest(effectiveRequest, context.outputSchema, {
            kind: adapter.kind,
            capabilities: lookupCapabilities(
              { ...request.model, provider: adapter.kind },
              adapter.capabilities,
            ).capabilities,
            ...(this.options.maxRung === undefined ? {} : { maxRung: this.options.maxRung }),
          });
    const limiter = this.limiters.get(adapter.provider);
    let semaphore = this.semaphores.get(adapter.provider);
    if (semaphore === undefined) {
      semaphore = new Semaphore(this.maxConcurrent);
      this.semaphores.set(adapter.provider, semaphore);
    }
    return this.completePrepared({
      request: effectiveRequest,
      context,
      adapter,
      prepared,
      limiter,
      semaphore,
    });
  }
}
