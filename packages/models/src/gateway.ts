// SPDX-License-Identifier: Apache-2.0
import {
  Code,
  lookupCapabilities,
  ModelEnforcementConfigSchema,
  ModelRetryConfigSchema,
  type Capabilities,
  type Id,
  type JsonValue,
  type ModelsConfig,
  type ModelRef,
  type ModelRequest,
  type ModelResponse,
  type ModelUsage,
  type ModelEnforcementConfig,
  type ModelRetryConfig,
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
import { providerSchemaRules } from "./provider-schema-rules.js";
import {
  EnforcementRungUnavailableError,
  OutputWithToolsUnsupportedError,
  selectEnforcementRung,
  type EnforcementResult,
  type EnforcementRung,
  type ValueTransform,
} from "./enforce/index.js";
import { enforceNativeOutput, withNativeOutputSchema } from "./enforce/rung-native.js";
import { enforceToolOutput, withForcedOutputTool } from "./enforce/rung-tool.js";
import { enforcePromptOutput, withPromptOutput } from "./enforce/rung-prompt.js";
import { lowerForProvider, schemaHash, toJsonSchema } from "./json-schema.js";
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
}

/** Runtime context supplied to a gateway call, optionally including a typed output contract. */
export interface ModelGatewayContext<OutputSchema extends z.ZodType = z.ZodType> {
  readonly runId: Id;
  readonly signal: AbortSignal;
  readonly deadlineTs?: number;
  readonly outputSchema?: OutputSchema;
  /** Optional async validator that preserves the tokenized model output. */
  readonly valueTransform?: ValueTransform;
}

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

interface PreparedEnforcement {
  readonly request: ModelRequest;
  readonly rung?: EnforcementRung;
}

interface ProviderEnforcement {
  readonly kind: string;
  readonly capabilities: Capabilities;
  readonly maxRung?: EnforcementRung;
}

interface PreparedCompletionOptions<OutputSchema extends z.ZodType> {
  readonly request: ModelRequest;
  readonly context: ModelGatewayContext<OutputSchema>;
  readonly adapter: ProviderAdapter;
  readonly prepared: PreparedEnforcement;
  readonly limiter: TokenBucketRateLimiter | undefined;
  readonly semaphore: Semaphore;
}

function prepareEnforcementRequest(
  request: ModelRequest,
  outputSchema: z.ZodType | undefined,
  provider: ProviderEnforcement,
): PreparedEnforcement {
  if (outputSchema === undefined) {
    return { request };
  }
  if (request.tools !== undefined && request.tools.length > 0) {
    throw new OutputWithToolsUnsupportedError();
  }

  const schemaRules = providerSchemaRules(provider.kind);
  let rung: EnforcementRung | undefined;
  if (schemaRules === undefined) {
    rung = provider.maxRung === "native" || provider.maxRung === "tool" ? undefined : "prompt";
  } else {
    rung = selectEnforcementRung(provider.capabilities, provider.maxRung);
  }
  if (rung === undefined) {
    throw new EnforcementRungUnavailableError();
  }

  const schema =
    schemaRules === undefined
      ? toJsonSchema(outputSchema)
      : lowerForProvider(outputSchema, provider.kind).schema;
  const output = {
    name: request.output?.name ?? "result",
    schema,
    schemaHash: schemaHash(schema),
  };
  return {
    request: prepareRequestForRung(request, output, rung),
    rung,
  };
}

function prepareRequestForRung(
  request: ModelRequest,
  output: NonNullable<ModelRequest["output"]>,
  rung: EnforcementRung,
): ModelRequest {
  if (rung === "native") {
    return withNativeOutputSchema(request, output);
  }
  if (rung === "tool") {
    return withForcedOutputTool(request, output);
  }
  return withPromptOutput(request, output);
}

async function enforceProviderOutput<OutputSchema extends z.ZodType>(
  parts: ModelResponse["parts"],
  context: ModelGatewayContext<OutputSchema>,
  rung: EnforcementRung | undefined,
): Promise<{
  readonly parts: ModelResponse["parts"];
  readonly result?: EnforcementResult<OutputSchema>;
}> {
  if (context.outputSchema === undefined || rung === undefined) {
    return { parts };
  }
  const { outputSchema, valueTransform } = context;
  if (rung === "native") {
    const hasToolCall = parts.some((part) => part.type === "tool_call");
    return {
      parts: hasToolCall ? parts.filter((part) => part.type !== "tool_call") : parts,
      result: await enforceNativeOutput(parts, outputSchema, valueTransform),
    };
  }
  if (rung === "tool") {
    const enforced = await enforceToolOutput(parts, outputSchema, valueTransform);
    return { parts: enforced.parts, result: enforced.result };
  }
  const hasToolCall = parts.some((part) => part.type === "tool_call");
  return {
    parts: hasToolCall ? parts.filter((part) => part.type !== "tool_call") : parts,
    result: await enforcePromptOutput(parts, outputSchema, valueTransform),
  };
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
          return await adapter.complete(
            {
              ...request,
              messages: prepareMessagesForProvider(request.messages, adapter.provider),
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
  ): Promise<ModelGatewayResponse<OutputSchema>> {
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

        const enforced = await enforceProviderOutput(result.parts, context, prepared.rung);
        const enforcement = enforced.result;
        if (enforcement !== undefined && "issues" in enforcement) {
          if (repairAttempts >= this.maxRepairs) {
            throw new ModelOutputInvalidError(
              repairAttempts,
              enforcement.issues,
              currentRequest.output?.schema,
              { usage: aggregateUsage, latencyMs: aggregateLatencyMs },
            );
          }
          currentRequest = appendRepairMessages(
            currentRequest,
            result.parts,
            enforcement.issues,
            enforcement.rungUsed,
          );
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
  async complete<OutputSchema extends z.ZodType = z.ZodType>(
    request: ModelRequest,
    context: ModelGatewayContext<OutputSchema>,
  ): Promise<ModelGatewayResponse<OutputSchema>> {
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
