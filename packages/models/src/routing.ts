// SPDX-License-Identifier: Apache-2.0
import {
  Code,
  HarnessError,
  type ModelRequest,
  type ModelRoutingConfigSchema,
} from "@harness/schemas";
import type { z } from "zod";
import { ModelOutputInvalidError } from "./errors.js";
import {
  ModelGateway,
  type ModelGatewayContext,
  type ModelGatewayDependencies,
  type ModelGatewayOptions,
  type ModelGatewayResponse,
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
    this.gateway = new ModelGateway(registry, dependencies, options);
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
  async complete<OutputSchema extends z.ZodType = z.ZodType>(
    request: ModelRequest,
    context: ModelGatewayContext<OutputSchema>,
  ): Promise<ModelGatewayResponse<OutputSchema>> {
    const candidates = requestCandidates(request, this.routing);
    for (const [index, model] of candidates.slice(0, -1).entries()) {
      try {
        const result = await this.gateway.complete({ ...request, model }, context);
        return { ...result, fallbackDepth: index };
      } catch (error) {
        const code = errorCode(error);
        if (
          index === candidates.length - 1 ||
          code === undefined ||
          !this.routing.fallbackOn.includes(code)
        ) {
          throw error;
        }
      }
    }
    const fallbackDepth = candidates.length - 1;
    const finalModel = candidates.at(-1) ?? request.model;
    const result = await this.gateway.complete({ ...request, model: finalModel }, context);
    return { ...result, fallbackDepth };
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
