// SPDX-License-Identifier: Apache-2.0
import { specTypeSchemas, type InputResponses } from "@modelcontextprotocol/client";
import type { Code, Id, InputResponse } from "@rovinos/schemas";
import type { ValidatedInputRequest } from "./validate.js";

/** Durable request data handed from the MCP boundary to the run loop. */
export interface ElicitationInputRequired {
  readonly callId: Id;
  readonly serverId: Code;
  readonly source?: "mcp_mrtr" | "mcp_legacy";
  readonly round: number;
  readonly inputRequests: readonly ValidatedInputRequest[];
  readonly sensitiveInputKeys: readonly string[];
  readonly policyDeclinedInputKeys?: readonly string[];
  readonly maxPerRun: number;
  readonly signal?: AbortSignal;
  readonly requestState?: string;
}

/** Outcome after core has durably recorded an MRTR input-required response. */
export type ElicitationInputOutcome =
  | { readonly kind: "suspend" }
  | { readonly kind: "retry"; readonly inputResponses: Readonly<Record<string, InputResponse>> }
  | {
      readonly kind: "error";
      readonly errorCode: "mcp_input_rate_limited" | "mcp_input_request_invalid";
    };

/** Core-owned durable handler for MCP multi-round-trip input requests. */
export interface ElicitationPort {
  handleInputRequired(input: ElicitationInputRequired): Promise<ElicitationInputOutcome>;
  /** Records and presents one legacy live request, returning its durable human resolution. */
  handleLegacyLive?(input: LegacyElicitationInput): Promise<InputResponse | undefined>;
  /** Records a timeout resolution for a legacy request that received no channel answer. */
  recordLegacyTimeout?(input: LegacyElicitationInput): Promise<void>;
  /** Records a request and policy decline without presenting it to a human. */
  recordLegacyPolicyDecline?(input: LegacyElicitationInput): Promise<void>;
  /** Notifies the run loop that a known legacy URL elicitation completed server-side. */
  onLegacyComplete?(input: Omit<LegacyElicitationInput, "request" | "timeoutMs" | "signal">): void;
}

/** Retry material supplied by the resume planner for the same MCP tool call. */
export interface ElicitationRetry {
  readonly inputResponses: Readonly<Record<string, InputResponse>>;
  readonly round: number;
  readonly source?: "mcp_mrtr" | "mcp_legacy";
  readonly requestState?: string;
}

/** Legacy live request presented while its originating server tool call is in flight. */
export interface LegacyElicitationInput {
  readonly callId: Id;
  readonly serverId: Code;
  readonly elicitationId: string;
  readonly request: ValidatedInputRequest;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}

/** Creates the wire response shape for a human resolution. */
export function toWireInputResponses(
  inputResponses: Readonly<Record<string, InputResponse>>,
): InputResponses {
  const entries = Object.entries(inputResponses).map(([inputKey, response]) => {
    if (
      response.answer !== undefined &&
      (typeof response.answer !== "object" ||
        response.answer === null ||
        Array.isArray(response.answer))
    ) {
      throw new TypeError("Resolved input does not match the MCP elicitation response schema.");
    }
    const validated = specTypeSchemas.ElicitResult["~standard"].validate({
      action: response.action,
      content: response.answer ?? {},
    });
    if (validated.issues !== undefined) {
      throw new TypeError("Resolved input does not match the MCP elicitation response schema.");
    }
    return [inputKey, validated.value] as const;
  });
  return Object.fromEntries(entries) satisfies InputResponses;
}
