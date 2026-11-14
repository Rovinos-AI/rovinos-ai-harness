// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import {
  JsonValue as JsonValueSchema,
  ModelRequestSchema,
  Sha256Hex,
  costValueFromUsage,
  type Code,
  type Id,
  type ToolSpec,
} from "@rovinos/schemas";
import {
  modelRequestParametersHash,
  storedModelRequestHash,
  canonicalJson,
} from "@rovinos/schemas/request-signature";
import { z } from "zod";
import type { EventPartial } from "../recorder.js";
import type { ModelCompletion, ModelRequest } from "../ports.js";
import type { ModelStepOptions } from "./model-step.js";

/** Builds the normalized request and its durable event payload. */
export function requestParts(
  options: ModelStepOptions,
  requestId: Id,
  maxOutputTokens?: number,
): {
  readonly modelRequest: ModelRequest;
  readonly requestPartial: Extract<EventPartial, { readonly type: "model_request" }>;
} {
  const role = options.role;
  const modelRequest = ModelRequestSchema.parse({
    requestId,
    model: {
      provider: options.provider ?? "unknown",
      model: options.modelName ?? "unknown",
    },
    messages: options.messages,
    stablePrefixMessages: options.contextMetadata.stablePrefixMessages,
    ...(options.tools === undefined ? {} : { tools: [...options.tools] }),
    ...(role === undefined ? {} : { role }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
  });
  const requestParametersHash = modelRequestParametersHash(modelRequest);
  return {
    modelRequest,
    requestPartial: {
      type: "model_request",
      v: 3,
      requestId,
      provider: options.provider ?? "unknown",
      model: options.modelName ?? "unknown",
      messages: options.messages,
      advertisedToolIds: modelRequest.tools?.map(({ toolId }) => toolId) ?? [],
      requestHash: storedModelRequestHash(modelRequest.messages, requestParametersHash),
      requestParametersHash,
      ...(role === undefined ? {} : { role }),
    },
  };
}

/** Counts model-visible tool definitions without retaining their content. */
export function toolDefinitionDiagnostics(tools: readonly ToolSpec[] | undefined): {
  readonly count: number;
  readonly bytes: number;
} {
  if (tools === undefined || tools.length === 0) {
    return { count: 0, bytes: 0 };
  }
  return {
    count: tools.length,
    bytes: Buffer.byteLength(JSON.stringify(tools), "utf8"),
  };
}

/** Produces the stable digest used to deduplicate response settlement. */
export function responseHash(
  response: Extract<EventPartial, { readonly type: "model_response" }>,
): ReturnType<typeof Sha256Hex.parse> {
  return Sha256Hex.parse(
    createHash("sha256")
      .update(canonicalJson(response) ?? "null")
      .digest("hex"),
  );
}

/** Creates the durable response event payload from a provider completion. */
export function responsePayload(
  requestId: Id,
  completion: ModelCompletion,
  structuredValue: ModelCompletion["providerBlobs"] | undefined,
  costWarningCode: Code | undefined,
): Extract<EventPartial, { readonly type: "model_response" }> {
  return {
    type: "model_response",
    v: 2,
    requestId,
    provider: completion.provider,
    model: completion.model,
    inputTokens: completion.usage.inputTokens,
    outputTokens: completion.usage.outputTokens,
    ...(completion.usage.cacheReadTokens === undefined
      ? {}
      : { cacheReadTokens: completion.usage.cacheReadTokens }),
    ...(completion.usage.cacheWriteTokens === undefined
      ? {}
      : { cacheWriteTokens: completion.usage.cacheWriteTokens }),
    cost: costValueFromUsage(completion.usage),
    ...(costWarningCode === undefined ? {} : { costWarningCode }),
    finishReason: completion.finishReason,
    latencyMs: completion.latencyMs,
    schemaValid: completion.schemaValid,
    repairAttempts: completion.repairAttempts,
    ...(completion.rungUsed === undefined ? {} : { rungUsed: completion.rungUsed }),
    fallbackDepth: completion.fallbackDepth,
    ...(structuredValue === undefined ? {} : { structuredValue }),
    content: completion.parts,
    providerBlobs: completion.providerBlobs,
  };
}

/** Returns the tokenized structured result only when it satisfies the owned contract. */
export function tokenizedStructuredValue(
  completion: ModelCompletion,
): ModelCompletion["providerBlobs"] | undefined {
  if (completion.enforcement === undefined) {
    return undefined;
  }
  const parsed = ModelGatewayEnforcementSchema.safeParse(completion.enforcement);
  return parsed.success ? parsed.data.value : undefined;
}

const ModelGatewayEnforcementSchema = z
  .object({
    value: JsonValueSchema,
    valid: z.literal(true),
    rungUsed: z.enum(["native", "tool", "prompt"]),
  })
  .strict();
