// SPDX-License-Identifier: Apache-2.0
import {
  Code,
  lookupCapabilities,
  ModelRetryConfigSchema,
  type Capabilities,
  type Id,
  type JsonValue,
  type ModelRequest,
  type ModelResponse,
  type ModelRetryConfig,
} from "@harness/schemas";
import { setActiveSpanAttribute } from "@harness/telemetry";
import type { z } from "zod";
import { ProviderResultSchema, type Clock, type IdGenerator } from "./types.js";
import type { AdapterRegistry } from "./registry.js";
import { ProviderError } from "./errors.js";
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
} from "./enforce/index.js";
import { enforceNativeOutput, withNativeOutputSchema } from "./enforce/rung-native.js";
import { enforceToolOutput, withForcedOutputTool } from "./enforce/rung-tool.js";
import { enforcePromptOutput, withPromptOutput } from "./enforce/rung-prompt.js";
import { lowerForProvider, schemaHash, toJsonSchema } from "./json-schema.js";

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

/** Runtime context supplied to a gateway call, optionally including a typed output contract. */
export interface ModelGatewayContext<OutputSchema extends z.ZodType = z.ZodType> {
  readonly runId: Id;
  readonly signal: AbortSignal;
  readonly deadlineTs?: number;
  readonly outputSchema?: OutputSchema;
}

/** Gateway enforcement configuration. */
export interface ModelGatewayOptions {
  /** Highest rung on the native (1) < tool (2) < prompt (3) ladder. */
  readonly maxRung?: EnforcementRung;
}

/** Provider completion with optional structured-output validation details. */
export type ModelGatewayResponse<OutputSchema extends z.ZodType = z.ZodType> = ModelResponse & {
  readonly providerBlobs: JsonValue;
  readonly enforcement?: EnforcementResult<OutputSchema>;
};

interface PreparedEnforcement<OutputSchema extends z.ZodType> {
  readonly request: ModelRequest;
  readonly rung?: EnforcementRung;
  readonly result?: EnforcementResult<OutputSchema>;
}

function prepareEnforcementRequest<OutputSchema extends z.ZodType>(
  request: ModelRequest,
  outputSchema: OutputSchema | undefined,
  capabilities: Capabilities,
  maxRung?: EnforcementRung,
): PreparedEnforcement<OutputSchema> {
  if (outputSchema === undefined) {
    return { request };
  }
  if (request.tools !== undefined && request.tools.length > 0) {
    throw new OutputWithToolsUnsupportedError();
  }

  const rung = selectEnforcementRung(capabilities, maxRung);
  const schemaRules = providerSchemaRules(request.model.provider);
  if (rung === undefined || (schemaRules === undefined && rung !== "prompt")) {
    throw new EnforcementRungUnavailableError();
  }

  const schema =
    schemaRules === undefined
      ? toJsonSchema(outputSchema)
      : lowerForProvider(outputSchema, request.model.provider).schema;
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

function enforceProviderOutput<OutputSchema extends z.ZodType>(
  parts: ModelResponse["parts"],
  outputSchema: OutputSchema | undefined,
  rung: EnforcementRung | undefined,
): {
  readonly parts: ModelResponse["parts"];
  readonly result?: EnforcementResult<OutputSchema>;
} {
  if (outputSchema === undefined || rung === undefined) {
    return { parts };
  }
  if (rung === "native") {
    const hasToolCall = parts.some((part) => part.type === "tool_call");
    return {
      parts: hasToolCall ? parts.filter((part) => part.type !== "tool_call") : parts,
      result: enforceNativeOutput(parts, outputSchema),
    };
  }
  if (rung === "tool") {
    const enforced = enforceToolOutput(parts, outputSchema);
    return { parts: enforced.parts, result: enforced.result };
  }
  const hasToolCall = parts.some((part) => part.type === "tool_call");
  return {
    parts: hasToolCall ? parts.filter((part) => part.type !== "tool_call") : parts,
    result: enforcePromptOutput(parts, outputSchema),
  };
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
    private readonly options: ModelGatewayOptions = {},
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
   * @param context - Run identifier, cancellation signal, optional deadline, and output schema.
   * @returns Provider completion with validation details when output enforcement is requested.
   */
  async complete<OutputSchema extends z.ZodType = z.ZodType>(
    request: ModelRequest,
    context: ModelGatewayContext<OutputSchema>,
  ): Promise<ModelGatewayResponse<OutputSchema>> {
    const adapter = this.registry.get(request.model.provider);
    const prepared =
      context.outputSchema === undefined
        ? { request }
        : prepareEnforcementRequest(
            request,
            context.outputSchema,
            lookupCapabilities(request.model, adapter.capabilities).capabilities,
            this.options.maxRung,
          );
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
      prepareAttempt: async (signal, lastError) => {
        if (limiter !== undefined) {
          await limiter.acquire(signal, context.deadlineTs, lastError);
        }
        return semaphore.acquire(signal);
      },
      operation: (signal) => {
        attempts += 1;
        setActiveSpanAttribute("harness.model.attempts", attempts);
        return adapter.complete(
          {
            ...prepared.request,
            messages: prepareMessagesForProvider(prepared.request.messages, adapter.provider),
          },
          {
            signal,
            ids: this.dependencies.ids,
            clock: this.dependencies.clock,
            ...(context.deadlineTs === undefined ? {} : { deadlineTs: context.deadlineTs }),
          },
        );
      },
    });
    const parsedResult = ProviderResultSchema.safeParse(adapterResult);
    if (!parsedResult.success) {
      throw new ProviderError("provider_unknown");
    }
    const result = parsedResult.data;

    const enforced = enforceProviderOutput(result.parts, context.outputSchema, prepared.rung);
    const enforcement = prepared.result ?? enforced.result;

    return {
      parts: enforced.parts,
      usage: result.usage,
      finishReason: result.finishReason,
      provider: adapter.provider,
      model: request.model.model,
      latencyMs: result.latencyMs,
      schemaValid: enforcement?.valid ?? true,
      repairAttempts: 0,
      ...(enforcement === undefined ? {} : { enforcement }),
      ...(enforcement?.rungUsed === undefined ? {} : { rungUsed: enforcement.rungUsed }),
      fallbackDepth: 0,
      providerBlobs: null,
    };
  }
}
