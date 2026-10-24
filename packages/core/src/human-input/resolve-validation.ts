// SPDX-License-Identifier: Apache-2.0
import {
  InputRequestSchema,
  JsonValue as JsonValueSchema,
  type Code,
  type Id,
  type InputRequest,
} from "@rovinos/schemas";
import { validateWithTokens } from "@rovinos/pii";
import type { AuditingVaultResolver } from "@rovinos/vault";
import { findTokens } from "@rovinos/vault";
import { InputDestinationUnavailableError, InputSchemaUnavailableError } from "./resolve-errors.js";
import type { InputRequestedEvent, RunState, ToolIntentEvent } from "../run-state.js";

/** Constructs an untrusted input event's normalized request projection. */
export function requestForValidation(event: InputRequestedEvent): InputRequest {
  return InputRequestSchema.parse({
    requestId: event.requestId,
    source: event.source,
    ...(event.serverId === undefined ? {} : { serverId: event.serverId }),
    ...(event.callId === undefined ? {} : { callId: event.callId }),
    ...(event.inputKey === undefined ? {} : { inputKey: event.inputKey }),
    round: event.round,
    mode: event.mode,
    message: event.message,
    ...(event.schema === undefined ? {} : { schema: event.schema }),
    ...(event.url === undefined ? {} : { url: event.url }),
    ...(event.expiresAt === undefined ? {} : { expiresAt: event.expiresAt }),
  });
}

/** Restores protected schema constraints only in memory for answer validation. */
export async function inputRequestForValidation(
  runId: Id,
  request: InputRequest,
  intent: ToolIntentEvent | undefined,
  resolver: AuditingVaultResolver | undefined,
): Promise<InputRequest> {
  if (request.schema === undefined) {
    return request;
  }
  const serialized = JSON.stringify(request.schema);
  if (findTokens(serialized).length === 0) {
    return request;
  }
  if (resolver === undefined) {
    throw new InputSchemaUnavailableError();
  }
  const tokenizedSchema = JsonValueSchema.safeParse(request.schema);
  if (!tokenizedSchema.success) {
    throw new InputSchemaUnavailableError();
  }
  const result = await validateWithTokens(JsonValueSchema, tokenizedSchema.data, {
    runId,
    resolver,
    ...(intent === undefined ? {} : { toolId: intent.toolId }),
    wantRaw: true,
  });
  if (!result.ok || result.raw === undefined) {
    throw new InputSchemaUnavailableError();
  }
  const parsed = InputRequestSchema.safeParse({ ...request, schema: result.raw });
  if (!parsed.success) {
    throw new InputSchemaUnavailableError();
  }
  return parsed.data;
}

/** Chooses the originating tool, allowing the broader destination only for agent inputs. */
export function inputDestination(
  request: InputRequestedEvent,
  state: RunState,
): { readonly tool: Code } | "any" {
  if (request.source === "agent") {
    return "any";
  }
  if (request.callId === undefined) {
    throw new InputDestinationUnavailableError();
  }
  const intent = state.pendingToolCalls.get(request.callId);
  if (intent === undefined) {
    throw new InputDestinationUnavailableError();
  }
  return { tool: intent.toolId };
}
