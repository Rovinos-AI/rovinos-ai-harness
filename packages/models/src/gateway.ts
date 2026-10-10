// SPDX-License-Identifier: Apache-2.0
import { lookupCapabilities } from "@harness/schemas";
import type { Capabilities, Id, JsonValue, ModelRequest, ModelResponse } from "@harness/schemas";
import type { z } from "zod";
import type { Clock, IdGenerator } from "./types.js";
import type { AdapterRegistry } from "./registry.js";
import { ProviderError } from "./errors.js";
import { ProviderResultSchema } from "./types.js";
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
import { lowerForProvider, schemaHash } from "./json-schema.js";

/** Dependencies injected into every provider adapter call by the gateway. */
export interface ModelGatewayDependencies {
  readonly ids: IdGenerator;
  readonly clock: Clock;
}

/** Runtime context supplied to a gateway call, optionally including a typed output contract. */
export interface ModelGatewayContext<OutputSchema extends z.ZodType = z.ZodType> {
  readonly runId: Id;
  readonly signal: AbortSignal;
  readonly outputSchema?: OutputSchema;
}

/** Gateway enforcement configuration. */
export interface ModelGatewayOptions {
  /** Highest rung on the native (1) < tool (2) ladder; "native" forbids selecting the tool rung. */
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

  if (providerSchemaRules(request.model.provider) === undefined) {
    throw new EnforcementRungUnavailableError();
  }
  const rung = selectEnforcementRung(capabilities, maxRung);
  if (rung === undefined) {
    throw new EnforcementRungUnavailableError();
  }

  const lowered = lowerForProvider(outputSchema, request.model.provider);
  const output = {
    name: request.output?.name ?? "result",
    schema: lowered.schema,
    schemaHash: schemaHash(lowered.schema),
  };
  return {
    request:
      rung === "native"
        ? withNativeOutputSchema(request, output)
        : withForcedOutputTool(request, output),
    rung,
  };
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
  const enforced = enforceToolOutput(parts, outputSchema);
  return { parts: enforced.parts, result: enforced.result };
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
    private readonly options: ModelGatewayOptions = {},
  ) {}

  /**
   * Completes a request through the adapter selected by its provider code.
   *
   * @param request - Normalized provider-neutral request.
   * @param context - Run identifier, cancellation signal, and optional output schema.
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
    const adapterResult = await adapter.complete(prepared.request, {
      signal: context.signal,
      ids: this.dependencies.ids,
      clock: this.dependencies.clock,
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
