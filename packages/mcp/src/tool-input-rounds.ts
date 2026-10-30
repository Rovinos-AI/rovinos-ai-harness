// SPDX-License-Identifier: Apache-2.0
import {
  isInputRequiredResult,
  type CallToolResult,
  type ElicitRequest,
  type ElicitResult,
} from "@modelcontextprotocol/client";
import { Id, type JsonValue as JsonValueType } from "@rovinos/schemas";
import type { ElicitationPort, ElicitationRetry } from "./elicitation/mrtr.js";
import type { ElicitationUrlOptions } from "./elicitation/url.js";
import { handleLegacyLiveElicitation, legacyUrlInputRequiredResult } from "./elicitation/legacy.js";
import { requestsSensitiveFormField } from "./elicitation/sensitive.js";
import { checkElicitationUrl } from "./elicitation/url.js";
import { validateInputRequiredResult } from "./elicitation/validate.js";
import { McpProtocolError } from "./errors.js";
import { handleInputRequiredCall } from "./input-required-call.js";
import type { ResolvedTool } from "./registry.js";
import type { McpConnection } from "./connection.js";

interface McpObjectToolCall {
  readonly callId: string;
  readonly args: Record<string, unknown>;
}

/** Result of one bounded MRTR or legacy input-required call sequence. */
export type ToolRoundOutcome =
  | { readonly kind: "result"; readonly result: CallToolResult }
  | { readonly kind: "failure"; readonly errorCode: string }
  | { readonly kind: "suspend" };

interface CallToolWithInputRoundsOptions {
  readonly connection: McpConnection;
  readonly route: ResolvedTool;
  readonly call: McpObjectToolCall & { readonly toolId: string };
  readonly signal: AbortSignal;
  readonly elicitation?: ElicitationPort;
  readonly inputRetry?: ElicitationRetry;
  readonly tokenizeHumanInput?: (value: JsonValueType) => Promise<JsonValueType>;
  readonly protectInputMetadata?: (value: string) => Promise<string>;
  readonly urlOptions?: ElicitationUrlOptions;
  readonly errorCode: (error: unknown, signal: AbortSignal) => string;
}

function createLegacyElicitation(options: CallToolWithInputRoundsOptions) {
  const parsedCallId = Id.safeParse(options.call.callId);
  const elicitation = options.elicitation;
  if (elicitation === undefined || !parsedCallId.success) {
    return undefined;
  }
  return {
    signal: options.signal,
    handle: async (
      requestParams: ElicitRequest["params"],
      elicitationId: string,
      requestSignal: AbortSignal,
    ): Promise<ElicitResult> => {
      let requests: ReturnType<typeof validateInputRequiredResult>["inputRequests"];
      try {
        requests = validateInputRequiredResult(
          {
            resultType: "input_required",
            inputRequests: {
              [elicitationId]: { method: "elicitation/create", params: requestParams },
            },
          },
          options.route.server,
        ).inputRequests;
      } catch {
        return { action: "cancel", content: {} };
      }
      const request = requests[0];
      if (request === undefined) {
        return { action: "cancel", content: {} };
      }
      const legacyInput = {
        callId: parsedCallId.data,
        serverId: options.route.server.id,
        elicitationId,
        request: { ...request, inputKey: elicitationId },
        timeoutMs: options.route.server.elicitation.legacyLiveTimeoutMs,
        signal: requestSignal,
      };
      if (
        (request.mode === "url" &&
          !checkElicitationUrl(request.url ?? "", options.urlOptions).accepted) ||
        requestsSensitiveFormField(request)
      ) {
        await elicitation.recordLegacyPolicyDecline?.(legacyInput);
        return { action: "decline", content: {} };
      }
      return handleLegacyLiveElicitation({
        active: true,
        request: legacyInput.request,
        timeoutMs: legacyInput.timeoutMs,
        signal: requestSignal,
        handle: (validatedRequest, liveSignal) =>
          elicitation.handleLegacyLive?.({
            ...legacyInput,
            request: validatedRequest,
            signal: liveSignal,
          }) ?? Promise.resolve(undefined),
        onTimeout: (validatedRequest) =>
          elicitation.recordLegacyTimeout?.({
            ...legacyInput,
            request: validatedRequest,
          }) ?? Promise.resolve(),
      });
    },
    onComplete: (elicitationId: string) => {
      elicitation.onLegacyComplete?.({
        callId: parsedCallId.data,
        serverId: options.route.server.id,
        elicitationId,
      });
    },
  };
}

async function callRound(options: {
  readonly connection: McpConnection;
  readonly route: ResolvedTool;
  readonly call: McpObjectToolCall;
  readonly signal: AbortSignal;
  readonly inputRetry: ElicitationRetry | undefined;
  readonly legacyElicitation: ReturnType<typeof createLegacyElicitation>;
  readonly errorCode: CallToolWithInputRoundsOptions["errorCode"];
}): Promise<
  { readonly result: CallToolResult; readonly source: "mcp_mrtr" | "mcp_legacy" } | ToolRoundOutcome
> {
  try {
    return {
      result: await options.connection.callTool({
        params: { name: options.route.nativeName, arguments: options.call.args },
        inputSchema: options.route.inputSchema,
        options: { signal: options.signal },
        toolDefinition: options.route.tool,
        ...(options.inputRetry === undefined ? {} : { inputRetry: options.inputRetry }),
        ...(options.legacyElicitation === undefined
          ? {}
          : { legacyElicitation: options.legacyElicitation }),
      }),
      source: "mcp_mrtr",
    };
  } catch (error) {
    if (error instanceof McpProtocolError && error.protocolCode === -32042) {
      const result = legacyUrlInputRequiredResult(error);
      return result === undefined
        ? { kind: "failure", errorCode: "mcp_input_request_invalid" }
        : { result, source: "mcp_legacy" };
    }
    return { kind: "failure", errorCode: options.errorCode(error, options.signal) };
  }
}

/** Runs bounded MRTR rounds and routes legacy live requests through the same broker port. */
export async function callToolWithInputRounds(
  options: CallToolWithInputRoundsOptions,
): Promise<ToolRoundOutcome> {
  const legacyElicitation = createLegacyElicitation(options);
  let inputRetry = options.inputRetry;
  let round = inputRetry?.round ?? 0;
  for (;;) {
    if (
      inputRetry?.source === "mcp_legacy" &&
      Object.values(inputRetry.inputResponses).some((response) => response.action !== "accept")
    ) {
      return { kind: "failure", errorCode: "mcp_input_declined" };
    }
    const called = await callRound({
      connection: options.connection,
      route: options.route,
      call: options.call,
      signal: options.signal,
      inputRetry,
      legacyElicitation,
      errorCode: options.errorCode,
    });
    if ("kind" in called) {
      return called;
    }
    if (!isInputRequiredResult(called.result)) {
      return { kind: "result", result: called.result };
    }
    const handled = await handleInputRequiredCall({
      value: called.result,
      route: options.route,
      call: options.call,
      signal: options.signal,
      round,
      ...(called.source === "mcp_legacy" ? { source: called.source } : {}),
      ...(options.elicitation === undefined ? {} : { elicitation: options.elicitation }),
      ...(options.tokenizeHumanInput === undefined
        ? {}
        : { tokenizeHumanInput: options.tokenizeHumanInput }),
      ...(options.protectInputMetadata === undefined
        ? {}
        : { protectInputMetadata: options.protectInputMetadata }),
      ...(options.urlOptions === undefined ? {} : { urlOptions: options.urlOptions }),
    });
    if (handled.kind !== "retry") {
      return handled;
    }
    inputRetry = handled.inputRetry;
    round = inputRetry.round;
  }
}
