// SPDX-License-Identifier: Apache-2.0
import {
  Code,
  lookupCapabilities,
  ModelEnforcementConfigSchema,
  ModelRetryConfigSchema,
  type Id,
  type JsonValue,
  type Message,
  type ModelsConfig,
  type ModelRef,
  type ModelRequest,
  type ModelResponse,
  type ModelUsage,
  type ModelEnforcementConfig,
  type ModelRetryConfig,
  type PiiActionSummary,
} from "@harness/schemas";
import {
  emitPricingCacheMissing,
  emitPricingMissing,
  setActiveSpanAttribute,
} from "@harness/telemetry";
import type { z } from "zod";
import {
  ProviderResultSchema,
  type Clock,
  type IdGenerator,
  type ProviderAdapter,
} from "./types.js";
import type { AdapterRegistry } from "./registry.js";
import {
  attachModelFailureMetadata,
  ModelOutputInvalidError,
  ProviderError,
  readModelFailureMetadata,
} from "./errors.js";
import { prepareMessagesForProvider } from "./blobs.js";
import { TokenBucketRateLimiter } from "./resilience/limiter.js";
import { abortableSleep, withRetries, type Random, type Sleep } from "./resilience/retry.js";
import { Semaphore } from "./resilience/semaphore.js";
import {
  type EnforcementResult,
  type EnforcementIssue,
  type EnforcementRung,
  type TokenizedEnforcementResult,
  type ValueTransform,
} from "./enforce/index.js";
import {
  enforceProviderOutput,
  prepareEnforcementRequest,
  type PreparedEnforcement,
} from "./enforce/provider-output.js";
import { awaitRunValidation } from "./enforce/validation-deadline.js";
import { appendRepairMessages } from "./enforce/repair.js";
import { createPricingAccountant } from "./pricing.js";
import { aggregateModelUsage, reportModelUsage } from "./usage.js";

/** Dependencies injected into every provider adapter call by the gateway. */
export interface ModelGatewayDependencies {
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly retryPolicy?: ModelRetryConfig;
  readonly enforcement?: ModelEnforcementConfig;
  readonly random?: Random;
  readonly sleep?: Sleep;
  readonly requestsPerMinute?: Readonly<Partial<Record<Code, number>>>;
  readonly maxConcurrent?: number;
  readonly pricing?: ModelsConfig["pricing"];
  /** Per-provider trust resolved from validated runtime configuration. */
  readonly providerTrust?: Readonly<Partial<Record<Code, "hosted" | "local">>>;
  /** Boundary hook invoked after provider-specific message preparation on every attempt. */
  readonly messageSanitizer?: MessageSanitizer;
}

/** Sanitizes provider-prepared messages for one routed provider attempt. */
export type MessageSanitizer = (
  messages: Message[],
  target: ModelRef & { readonly trust: "hosted" | "local" },
  runId: Id,
  recordPiiAction?: (summary: PiiActionSummary) => Promise<void>,
) => Promise<Message[]>;

/** Runtime context supplied to a gateway call, optionally including a typed output contract. */
interface ModelGatewayContextBase<OutputSchema extends z.ZodType> {
  readonly runId: Id;
  readonly signal: AbortSignal;
  readonly deadlineTs?: number;
  readonly outputSchema?: OutputSchema;
  readonly recordPiiAction?: (summary: PiiActionSummary) => Promise<void>;
}

/** Runtime context supplied to a gateway call, optionally including a typed output contract. */
export type ModelGatewayContext<OutputSchema extends z.ZodType = z.ZodType> =
  ModelGatewayContextBase<OutputSchema> &
    ({ readonly valueTransform?: undefined } | { readonly valueTransform: ValueTransform });

/** Gateway context used when the caller provides an async token-preserving validator. */
export type TokenizedModelGatewayContext<OutputSchema extends z.ZodType = z.ZodType> =
  ModelGatewayContextBase<OutputSchema> & { readonly valueTransform: ValueTransform };

/** Gateway enforcement configuration. */
export interface ModelGatewayOptions {
  /** Highest rung on the native (1) < tool (2) < prompt (3) ladder. */
  readonly maxRung?: EnforcementRung;
  /** Defers model usage span attributes to the caller after routing aggregation. */
  readonly deferSpanUsage?: boolean;
}

/** Provider completion with optional structured-output validation details. */
export type ModelGatewayResponse<OutputSchema extends z.ZodType = z.ZodType> = ModelResponse & {
  readonly providerBlobs: JsonValue;
  readonly enforcement?: EnforcementResult<OutputSchema>;
};

/** Provider completion whose successful enforcement value remains tokenized JSON. */
export type TokenizedModelGatewayResponse = ModelResponse & {
  readonly providerBlobs: JsonValue;
  readonly enforcement?: TokenizedEnforcementResult;
};

type AnyModelGatewayResponse<OutputSchema extends z.ZodType> =
  ModelGatewayResponse<OutputSchema> | TokenizedModelGatewayResponse;

interface PreparedCompletionOptions<OutputSchema extends z.ZodType> {
  readonly request: ModelRequest;
  readonly context: ModelGatewayContext<OutputSchema>;
  readonly adapter: ProviderAdapter;
  readonly prepared: PreparedEnforcement;
  readonly limiter: TokenBucketRateLimiter | undefined;
  readonly semaphore: Semaphore;
}

function appendRepairOrThrow(options: {
  readonly currentRequest: ModelRequest;
  readonly parts: ModelResponse["parts"];
  readonly issues: readonly EnforcementIssue[];
  readonly rungUsed?: EnforcementRung;
  readonly outputSchema: JsonValue | undefined;
  readonly repairAttempts: number;
  readonly maxRepairs: number;
  readonly usage: ModelUsage | undefined;
  readonly latencyMs: number;
}): ModelRequest {
  if (options.repairAttempts >= options.maxRepairs) {
    throw new ModelOutputInvalidError(
      options.repairAttempts,
      options.issues,
      options.outputSchema,
      {
        ...(options.usage === undefined ? {} : { usage: options.usage }),
        latencyMs: options.latencyMs,
      },
    );
  }
  return appendRepairMessages(
    options.currentRequest,
    options.parts,
    options.issues,
    options.rungUsed,
  );
}

function parseProviderResult(result: unknown): z.infer<typeof ProviderResultSchema> {
  const parsed = ProviderResultSchema.safeParse(result);
  if (!parsed.success) {
    throw new ProviderError("provider_unknown");
  }
  return parsed.data;
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
    return withRetries({
      policy: this.retryPolicy,
      clock: this.dependencies.clock,
      random: this.random,
      sleep: this.sleep,
      signal: context.signal,
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
          const preparedMessages = prepareMessagesForProvider(request.messages, adapter.provider);
          const messages =
            this.dependencies.messageSanitizer === undefined
              ? preparedMessages
              : await this.dependencies.messageSanitizer(
                  preparedMessages,
                  {
                    ...request.model,
                    trust: this.dependencies.providerTrust?.[adapter.provider] ?? "hosted",
                  },
                  context.runId,
                  context.recordPiiAction,
                );
          return await adapter.complete(
            {
              ...request,
              messages,
            },
            {
              signal,
              ids: this.dependencies.ids,
              clock: this.dependencies.clock,
              ...(context.deadlineTs === undefined ? {} : { deadlineTs: context.deadlineTs }),
            },
          );
        } catch (error) {
          onFailedAttempt(error);
          throw error;
        }
      },
    });
  }

  private accountAndReportUsage(model: ModelRef, usage: ModelUsage): ModelUsage {
    const accounted = this.accountUsage(model, usage);
    reportModelUsage(model, accounted, this.options.deferSpanUsage === true);
    return accounted;
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
            attempts += 1;
            setActiveSpanAttribute("harness.model.attempts", attempts);
          },
          onFailedAttempt: (error) => {
            const metadata = readModelFailureMetadata(error);
            if (metadata.usage !== undefined) {
              aggregateUsage = aggregateModelUsage(aggregateUsage, metadata.usage);
            }
            aggregateLatencyMs += metadata.latencyMs ?? 0;
          },
        });
        const result = parseProviderResult(adapterResult);
        aggregateUsage = aggregateModelUsage(aggregateUsage, result.usage);
        aggregateLatencyMs += result.latencyMs;

        const validateOutput = () => enforceProviderOutput(result.parts, context, prepared.rung);
        const enforced = await awaitRunValidation(validateOutput, context, this.dependencies.clock);
        const enforcement = enforced.result;
        if (enforcement !== undefined && "issues" in enforcement) {
          currentRequest = appendRepairOrThrow({
            currentRequest,
            parts: result.parts,
            issues: enforcement.issues,
            ...(enforcement.rungUsed === undefined ? {} : { rungUsed: enforcement.rungUsed }),
            outputSchema: currentRequest.output?.schema,
            repairAttempts,
            maxRepairs: this.maxRepairs,
            usage: aggregateUsage,
            latencyMs: aggregateLatencyMs,
          });
          repairAttempts += 1;
          continue;
        }

        const usage = this.accountAndReportUsage(request.model, aggregateUsage);
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
      if (aggregateUsage === undefined) {
        throw error;
      }
      const usage = this.accountAndReportUsage(request.model, aggregateUsage);
      throw attachModelFailureMetadata(error, {
        usage,
        latencyMs: aggregateLatencyMs,
        repairAttempts,
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
