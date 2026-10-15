// SPDX-License-Identifier: Apache-2.0
import {
  Code,
  HarnessError,
  ModelUsageSchema,
  type ModelRequest,
  type ModelUsage,
  type ModelRoutingConfigSchema,
} from "@harness/schemas";
import { setActiveSpanAttribute } from "@harness/telemetry";
import type { z } from "zod";
import {
  attachModelFailureMetadata,
  ModelOutputInvalidError,
  type ModelFailureMetadata,
} from "./errors.js";
import {
  ModelGateway,
  type ModelGatewayContext,
  type ModelGatewayDependencies,
  type ModelGatewayOptions,
  type ModelGatewayResponse,
  type TokenizedModelGatewayContext,
  type TokenizedModelGatewayResponse,
} from "./gateway.js";
import { AdapterRegistry } from "./registry.js";
import type { ProviderAdapter } from "./types.js";

/** Raised when a configured routing target has no corresponding adapter. */
export class RoutingProviderUnknownError extends HarnessError {
  readonly code = "routing_provider_unknown";

  /** @param provider - Provider code referenced by the routing policy. */
  constructor(provider: string) {
    super(`Routing references an unknown provider: ${provider}.`);
  }
}

/** Validated routing policy used by the gateway. */
export type ModelRoutingConfig = z.infer<typeof ModelRoutingConfigSchema>;

function requestCandidates(
  request: ModelRequest,
  routing: ModelRoutingConfig,
): readonly ModelRequest["model"][] {
  const roleRoutes = request.role === undefined ? undefined : routing.roles[request.role];
  const configured =
    roleRoutes === undefined || roleRoutes.length === 0 ? routing.default : roleRoutes;
  return configured.length === 0 ? [request.model] : configured;
}

function errorCode(error: unknown): string | undefined {
  if (error instanceof ModelOutputInvalidError) {
    return error.code;
  }
  if (typeof error === "object" && error !== null && "code" in error) {
    const parsed = Code.safeParse(error.code);
    return parsed.success ? parsed.data : undefined;
  }
  return undefined;
}

function failureMetadata(error: unknown): ModelFailureMetadata {
  if (typeof error !== "object" || error === null) {
    return {};
  }
  const metadata: {
    usage?: ModelUsage;
    latencyMs?: number;
    repairAttempts?: number;
  } = {};
  if ("usage" in error) {
    const usage = ModelUsageSchema.safeParse(error.usage);
    if (usage.success) {
      metadata.usage = usage.data;
    }
  }
  if ("latencyMs" in error && typeof error.latencyMs === "number") {
    metadata.latencyMs = error.latencyMs;
  }
  if ("repairAttempts" in error && typeof error.repairAttempts === "number") {
    metadata.repairAttempts = error.repairAttempts;
  }
  return metadata;
}

function aggregateUsage(previous: ModelUsage | undefined, next: ModelUsage | undefined) {
  if (next === undefined) {
    return previous;
  }
  let costMicros: number | undefined;
  if (previous === undefined) {
    costMicros = next.costMicros;
  } else if (previous.costMicros !== undefined && next.costMicros !== undefined) {
    costMicros = previous.costMicros + next.costMicros;
  }
  const cacheReadTokens = aggregateOptionalUsageCount(
    previous?.cacheReadTokens,
    next.cacheReadTokens,
  );
  const cacheWriteTokens = aggregateOptionalUsageCount(
    previous?.cacheWriteTokens,
    next.cacheWriteTokens,
  );
  return {
    inputTokens: (previous?.inputTokens ?? 0) + next.inputTokens,
    outputTokens: (previous?.outputTokens ?? 0) + next.outputTokens,
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(costMicros === undefined ? {} : { costMicros }),
  };
}

function aggregateOptionalUsageCount(
  previous: number | undefined,
  next: number | undefined,
): number | undefined {
  if (previous === undefined && next === undefined) {
    return undefined;
  }
  return (previous ?? 0) + (next ?? 0);
}

function reportSpanUsage(usage: ModelUsage): void {
  setActiveSpanAttribute("harness.model.input_tokens", usage.inputTokens);
  setActiveSpanAttribute("harness.model.output_tokens", usage.outputTokens);
  if (usage.cacheReadTokens !== undefined) {
    setActiveSpanAttribute("harness.model.cache_read_tokens", usage.cacheReadTokens);
  }
  if (usage.cacheWriteTokens !== undefined) {
    setActiveSpanAttribute("harness.model.cache_write_tokens", usage.cacheWriteTokens);
  }
  if (usage.costMicros !== undefined) {
    setActiveSpanAttribute("harness.model.cost_micros", usage.costMicros);
  }
}

function shouldFallback(options: {
  readonly error: unknown;
  readonly code: string | undefined;
  readonly signal: AbortSignal;
  readonly hasNext: boolean;
  readonly fallbackOn: readonly string[];
}): boolean {
  const { error, code, signal, hasNext, fallbackOn } = options;
  if (
    !hasNext ||
    signal.aborted ||
    (error instanceof Error && error.name === "AbortError") ||
    code === "pii_blocked" ||
    code === "deadline_exceeded" ||
    code === "cancelled" ||
    code === "run_cancelled"
  ) {
    return false;
  }
  return code !== undefined && fallbackOn.includes(code);
}

/** Routes model requests through ordered provider/model candidates and fallback policy. */
export class RoutingModelGateway {
  private readonly gateway: ModelGateway;

  /**
   * @param registry - Available provider adapters.
   * @param dependencies - Retry, enforcement, and deterministic gateway dependencies.
   * @param routing - Ordered default and role-specific routes.
   * @param options - Optional enforcement rung cap.
   */
  constructor(
    registry: AdapterRegistry,
    dependencies: ModelGatewayDependencies,
    private readonly routing: ModelRoutingConfig,
    options?: ModelGatewayOptions,
  ) {
    this.gateway = new ModelGateway(registry, dependencies, {
      ...options,
      deferSpanUsage: true,
    });
    for (const candidate of [...routing.default, ...Object.values(routing.roles).flat()]) {
      try {
        registry.get(candidate.provider);
      } catch {
        throw new RoutingProviderUnknownError(candidate.provider);
      }
    }
  }

  /**
   * Completes a request using role routing and falls back only for configured error codes.
   *
   * @param request - Provider-neutral request and optional role.
   * @param context - Active run identifier, signal, deadline, and output schema.
   * @returns Completion from the successful provider with its fallback depth.
   */
  complete<OutputSchema extends z.ZodType = z.ZodType>(
    request: ModelRequest,
    context: Omit<ModelGatewayContext<OutputSchema>, "valueTransform"> & {
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
  ): Promise<ModelGatewayResponse<OutputSchema> | TokenizedModelGatewayResponse>;
  async complete<OutputSchema extends z.ZodType = z.ZodType>(
    request: ModelRequest,
    context: ModelGatewayContext<OutputSchema>,
  ): Promise<ModelGatewayResponse<OutputSchema> | TokenizedModelGatewayResponse> {
    const candidates = requestCandidates(request, this.routing);
    let accumulatedUsage: ModelUsage | undefined;
    let accumulatedLatencyMs = 0;
    let accumulatedRepairAttempts = 0;
    for (const [index, model] of candidates.entries()) {
      try {
        const result = await this.gateway.complete({ ...request, model }, context);
        const usage = aggregateUsage(accumulatedUsage, result.usage) ?? result.usage;
        reportSpanUsage(usage);
        return {
          ...result,
          usage,
          latencyMs: accumulatedLatencyMs + result.latencyMs,
          repairAttempts: accumulatedRepairAttempts + result.repairAttempts,
          fallbackDepth: index,
        };
      } catch (error) {
        const metadata = failureMetadata(error);
        accumulatedUsage = aggregateUsage(accumulatedUsage, metadata.usage);
        accumulatedLatencyMs += metadata.latencyMs ?? 0;
        accumulatedRepairAttempts += metadata.repairAttempts ?? 0;
        const code = errorCode(error);
        if (
          !shouldFallback({
            error,
            code,
            signal: context.signal,
            hasNext: index < candidates.length - 1,
            fallbackOn: this.routing.fallbackOn,
          })
        ) {
          if (accumulatedUsage === undefined) {
            throw error;
          }
          reportSpanUsage(accumulatedUsage);
          throw attachModelFailureMetadata(error, {
            usage: accumulatedUsage,
            latencyMs: accumulatedLatencyMs,
            repairAttempts: accumulatedRepairAttempts,
          });
        }
      }
    }
    throw new Error("Expected at least one model routing candidate.");
  }
}

/** Creates a routing gateway after validating every route against available adapters. */
export function createRoutingModelGateway(
  adapters: readonly ProviderAdapter[],
  dependencies: ModelGatewayDependencies,
  routing: ModelRoutingConfig,
  options?: ModelGatewayOptions,
): RoutingModelGateway {
  return new RoutingModelGateway(new AdapterRegistry(adapters), dependencies, routing, options);
}
