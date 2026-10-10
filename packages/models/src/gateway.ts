// SPDX-License-Identifier: Apache-2.0
import type { Id, JsonValue, ModelRequest, ModelResponse } from "@harness/schemas";
import type { Clock, IdGenerator } from "./types.js";
import type { AdapterRegistry } from "./registry.js";
import { ProviderError } from "./errors.js";
import { ProviderResultSchema } from "./types.js";

/** Dependencies injected into every provider adapter call by the gateway. */
export interface ModelGatewayDependencies {
  readonly ids: IdGenerator;
  readonly clock: Clock;
}

/** Minimal provider-selecting model port implementation. */
export class ModelGateway {
  /**
   * @param registry - Provider adapters available for requests.
   * @param dependencies - Deterministic runtime dependencies forwarded to adapters.
   */
  constructor(
    private readonly registry: AdapterRegistry,
    private readonly dependencies: ModelGatewayDependencies,
  ) {}

  /**
   * Completes a request through the adapter selected by its provider code.
   *
   * @param request - Normalized provider-neutral request.
   * @param context - Run identifier and cancellation signal.
   * @returns A minimal model-port completion without repair or fallback.
   */
  async complete(
    request: ModelRequest,
    context: { readonly runId: Id; readonly signal: AbortSignal },
  ): Promise<ModelResponse & { readonly providerBlobs: JsonValue }> {
    const adapter = this.registry.get(request.model.provider);
    const adapterResult = await adapter.complete(request, {
      signal: context.signal,
      ids: this.dependencies.ids,
      clock: this.dependencies.clock,
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
