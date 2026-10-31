// SPDX-License-Identifier: Apache-2.0
import { HarnessError, JsonValue } from "@rovinos/schemas";
import type { InputResponse, JsonValue as JsonValueType } from "@rovinos/schemas";
import { countMcpInputRequest } from "@rovinos/telemetry";
import type {
  ElicitationInputOutcome,
  ElicitationPort,
  ElicitationRetry,
} from "./elicitation/mrtr.js";
import { requestsSensitiveFormField } from "./elicitation/sensitive.js";
import { checkElicitationUrl, type ElicitationUrlOptions } from "./elicitation/url.js";
import {
  InputRequestContentSchema,
  McpInputRequestError,
  validateInputRequiredResult,
} from "./elicitation/validate.js";
import type { ResolvedTool } from "./registry.js";

/** The call identifier associated with the untrusted server response. */
interface ToolCallIdentity {
  readonly callId: string;
}

interface ProtectedInputRequests {
  readonly tokenizedRequests: readonly (ReturnType<
    typeof InputRequestContentSchema.parse
  >[number] & {
    readonly inputKey: string;
  })[];
  readonly protectedRequestState?: string;
  readonly rawKeysByProtectedKey: ReadonlyMap<string, string>;
  readonly sensitiveInputKeys: readonly string[];
  readonly policyDeclinedInputKeys: readonly string[];
  readonly sensitiveKeys: ReadonlySet<string>;
}

/** Result of validating and durably handling one elicitation round. */
export type InputRequiredCallOutcome =
  | { readonly kind: "failure"; readonly errorCode: string }
  | { readonly kind: "suspend" }
  | { readonly kind: "retry"; readonly inputRetry: ElicitationRetry };

function isRecorderFailure(error: unknown): boolean {
  return (
    error instanceof HarnessError &&
    (error.code === "run_event_record_failed" || error.code === "pii_summary_record_failed")
  );
}

function protectInputRequests(options: {
  readonly validated: ReturnType<typeof validateInputRequiredResult>;
  readonly tokenizedContent: JsonValueType;
  readonly protectedKeys: readonly string[];
  readonly protectedRequestState: string | undefined;
  readonly policyDeclinedKeys: ReadonlySet<string>;
}): ProtectedInputRequests {
  const { validated, tokenizedContent, protectedKeys, protectedRequestState, policyDeclinedKeys } =
    options;
  const tokenizedRequests = InputRequestContentSchema.parse(tokenizedContent);
  const rawKeysByProtectedKey = new Map(
    protectedKeys.map((protectedKey, index) => [
      protectedKey,
      validated.inputRequests[index]?.inputKey ?? "",
    ]),
  );
  const requestsWithKeys = tokenizedRequests.map((request, index) => {
    if (validated.inputRequests[index] === undefined) {
      throw new Error("Validated request count changed.");
    }
    const inputKey = protectedKeys[index];
    if (inputKey === undefined) {
      throw new Error("Protected request key is missing.");
    }
    return { ...request, inputKey };
  });
  const sensitiveInputKeys = requestsWithKeys
    .filter((request) => {
      const originalKey = rawKeysByProtectedKey.get(request.inputKey);
      return validated.inputRequests.some(
        (original) => original.inputKey === originalKey && requestsSensitiveFormField(original),
      );
    })
    .map(({ inputKey }) => inputKey);
  const policyDeclinedInputKeys = requestsWithKeys
    .filter((request) => policyDeclinedKeys.has(rawKeysByProtectedKey.get(request.inputKey) ?? ""))
    .map(({ inputKey }) => inputKey);
  return {
    tokenizedRequests: requestsWithKeys,
    ...(protectedRequestState === undefined ? {} : { protectedRequestState }),
    rawKeysByProtectedKey,
    sensitiveInputKeys,
    policyDeclinedInputKeys,
    sensitiveKeys: new Set(sensitiveInputKeys),
  };
}

async function tokenizeInputRequests(options: {
  readonly validated: ReturnType<typeof validateInputRequiredResult>;
  readonly tokenizeHumanInput: (value: JsonValueType) => Promise<JsonValueType>;
  readonly protectInputMetadata: (value: string) => Promise<string>;
  readonly urlOptions?: ElicitationUrlOptions;
}): Promise<ProtectedInputRequests> {
  const { validated, tokenizeHumanInput, protectInputMetadata } = options;
  const tokenizedContent = await tokenizeHumanInput(
    JsonValue.parse(validated.inputRequests.map(({ inputKey: _key, ...request }) => request)),
  );
  const protectedKeys = await Promise.all(
    validated.inputRequests.map(({ inputKey }) => protectInputMetadata(inputKey)),
  );
  const protectedRequestState =
    validated.requestState === undefined
      ? undefined
      : await protectInputMetadata(validated.requestState);
  const policyDeclinedKeys = new Set(
    validated.inputRequests
      .filter(
        (request) =>
          request.mode === "url" &&
          !checkElicitationUrl(request.url ?? "", options.urlOptions).accepted,
      )
      .map(({ inputKey }) => inputKey),
  );
  return protectInputRequests({
    validated,
    tokenizedContent,
    protectedKeys,
    protectedRequestState,
    policyDeclinedKeys,
  });
}

function restoreInputResponses(
  protectedResponses: Readonly<Record<string, InputResponse>>,
  rawKeysByProtectedKey: ReadonlyMap<string, string>,
): Record<string, InputResponse> | undefined {
  const rawResponses = new Map<string, InputResponse>();
  for (const [protectedKey, response] of Object.entries(protectedResponses)) {
    const inputKey = rawKeysByProtectedKey.get(protectedKey);
    if (inputKey === undefined) {
      return undefined;
    }
    rawResponses.set(inputKey, response);
  }
  return Object.fromEntries(rawResponses);
}

async function askForInput(options: {
  readonly elicitation: ElicitationPort;
  readonly source: "mcp_mrtr" | "mcp_legacy";
  readonly callId: string;
  readonly route: ResolvedTool;
  readonly round: number;
  readonly signal: AbortSignal;
  readonly requests: ProtectedInputRequests;
}): Promise<ElicitationInputOutcome> {
  return options.elicitation.handleInputRequired({
    callId: options.callId,
    serverId: options.route.server.id,
    source: options.source,
    round: options.round,
    maxPerRun: options.route.server.elicitation.maxPerRun,
    inputRequests: options.requests.tokenizedRequests,
    sensitiveInputKeys: options.requests.sensitiveInputKeys,
    policyDeclinedInputKeys: options.requests.policyDeclinedInputKeys,
    signal: options.signal,
    ...(options.requests.protectedRequestState === undefined
      ? {}
      : { requestState: options.requests.protectedRequestState }),
  });
}

/** Validates, protects, and persists one server input-required response. */
export async function handleInputRequiredCall(options: {
  readonly value: unknown;
  readonly route: ResolvedTool;
  readonly call: ToolCallIdentity;
  readonly signal: AbortSignal;
  readonly round: number;
  readonly source?: "mcp_mrtr" | "mcp_legacy";
  readonly elicitation?: ElicitationPort;
  readonly tokenizeHumanInput?: (value: JsonValueType) => Promise<JsonValueType>;
  readonly protectInputMetadata?: (value: string) => Promise<string>;
  readonly urlOptions?: ElicitationUrlOptions;
}): Promise<InputRequiredCallOutcome> {
  const prepared = await prepareInputRequired(options);
  if (prepared.kind === "failure") {
    return prepared;
  }
  const { round, validated, requests } = prepared;
  let outcome: ElicitationInputOutcome;
  try {
    outcome = await askForInput({
      elicitation: prepared.elicitation,
      source: options.source ?? "mcp_mrtr",
      callId: options.call.callId,
      route: options.route,
      round,
      signal: options.signal,
      requests,
    });
  } catch (error) {
    if (isRecorderFailure(error)) {
      throw error;
    }
    return { kind: "failure", errorCode: "mcp_input_request_invalid" };
  }
  if (outcome.kind === "error") {
    countMcpInputRequest(
      outcome.errorCode === "mcp_input_rate_limited" ? "rate_limited" : "rejected",
    );
    return { kind: "failure", errorCode: outcome.errorCode };
  }
  for (const request of requests.tokenizedRequests) {
    countMcpInputRequest(inputRequestOutcome(request, requests));
  }
  if (outcome.kind === "suspend") {
    return { kind: "suspend" };
  }

  function inputRequestOutcome(
    request: ProtectedInputRequests["tokenizedRequests"][number],
    protectedRequests: ProtectedInputRequests,
  ): "declined_sensitive" | "rejected" | "asked" {
    if (protectedRequests.sensitiveKeys.has(request.inputKey)) {
      return "declined_sensitive";
    }
    return protectedRequests.policyDeclinedInputKeys.includes(request.inputKey)
      ? "rejected"
      : "asked";
  }
  const inputResponses = restoreInputResponses(
    outcome.inputResponses,
    requests.rawKeysByProtectedKey,
  );
  if (inputResponses === undefined) {
    return { kind: "failure", errorCode: "mcp_input_request_invalid" };
  }
  return {
    kind: "retry",
    inputRetry: {
      inputResponses,
      round,
      ...(options.source === undefined ? {} : { source: options.source }),
      ...(validated.requestState === undefined ? {} : { requestState: validated.requestState }),
    },
  };
}

interface PreparedInputRequired {
  readonly kind: "ready";
  readonly round: number;
  readonly validated: ReturnType<typeof validateInputRequiredResult>;
  readonly requests: ProtectedInputRequests;
  readonly elicitation: ElicitationPort;
}

async function prepareInputRequired(options: {
  readonly value: unknown;
  readonly route: ResolvedTool;
  readonly round: number;
  readonly elicitation?: ElicitationPort;
  readonly tokenizeHumanInput?: (value: JsonValueType) => Promise<JsonValueType>;
  readonly protectInputMetadata?: (value: string) => Promise<string>;
  readonly urlOptions?: ElicitationUrlOptions;
}): Promise<PreparedInputRequired | Extract<InputRequiredCallOutcome, { kind: "failure" }>> {
  const round = options.round + 1;
  if (round > options.route.server.elicitation.maxRounds) {
    countMcpInputRequest("rounds_exceeded");
    return { kind: "failure", errorCode: "mcp_input_rounds_exceeded" };
  }
  let validated: ReturnType<typeof validateInputRequiredResult>;
  try {
    validated = validateInputRequiredResult(options.value, options.route.server);
  } catch (error) {
    countMcpInputRequest("rejected");
    return {
      kind: "failure",
      errorCode: error instanceof McpInputRequestError ? error.code : "mcp_input_request_invalid",
    };
  }
  if (
    options.elicitation === undefined ||
    options.tokenizeHumanInput === undefined ||
    options.protectInputMetadata === undefined
  ) {
    countMcpInputRequest("rejected");
    return { kind: "failure", errorCode: "mcp_input_request_invalid" };
  }
  let requests: ProtectedInputRequests;
  try {
    requests = await tokenizeInputRequests({
      validated,
      tokenizeHumanInput: options.tokenizeHumanInput,
      protectInputMetadata: options.protectInputMetadata,
      ...(options.urlOptions === undefined ? {} : { urlOptions: options.urlOptions }),
    });
  } catch (error) {
    if (isRecorderFailure(error)) {
      throw error;
    }
    return { kind: "failure", errorCode: "mcp_input_request_invalid" };
  }
  return {
    kind: "ready",
    round,
    validated,
    requests,
    elicitation: options.elicitation,
  };
}
