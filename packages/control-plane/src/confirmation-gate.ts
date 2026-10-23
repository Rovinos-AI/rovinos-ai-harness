// SPDX-License-Identifier: Apache-2.0
import { Code, Id, JsonValue } from "@harness/schemas";
import type { EventStore } from "@harness/store";
import { canonicalJson } from "@harness/models";
import {
  acceptedContent,
  createRequestStateCodec,
  inputRequired,
  type InputRequiredResult,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";

const CONFIRMATION_TTL_SECONDS = 300;
const DEFAULT_REQUEST_STATE_KEY = randomBytes(32);
const confirmSchema = z.object({ confirm: z.boolean() }).strict();
export const confirmationClientCapabilitiesSchema = z
  .object({
    elicitation: z
      .object({ form: z.record(z.string(), JsonValue).optional() })
      .loose()
      .optional(),
    extensions: z.record(z.string(), JsonValue).optional(),
  })
  .loose();

const confirmationStateSchema = z
  .object({
    stateId: z.string().min(1).max(128),
    tokenId: z.string().min(1).max(128),
    toolName: z.string().min(1).max(128),
    argumentsDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    targetId: Id,
    expiresAt: z.number().int().nonnegative(),
  })
  .strict();

type ConfirmationState = z.infer<typeof confirmationStateSchema>;

/** Request capability fields used by the confirmation and app-visibility gates. */
export type ConfirmationClientCapabilities = z.infer<typeof confirmationClientCapabilitiesSchema>;

/** Parameters that bind a human confirmation to one concrete tool call. */
export interface ConfirmationRequest {
  readonly toolName: string;
  readonly targetId: Id;
  readonly arguments: Readonly<Record<string, unknown>>;
  /** A summary containing only metadata and already-tokenized content. */
  readonly summary: string;
  readonly clientCapabilities: ConfirmationClientCapabilities | undefined;
}

/** Options for the fail-closed confirmation gate. */
export interface ConfirmationGateOptions {
  /** Store used to atomically persist consumed request-state identifiers. */
  readonly store?: Pick<EventStore, "consumeConfirmationState">;
  /** Stable HMAC key shared by server instances that handle the same retry. */
  readonly key?: Uint8Array | string;
  /** Provides epoch milliseconds for expiry checks. */
  readonly now?: () => number;
  /** Produces a stable client/token identifier for request binding. */
  readonly tokenId?: (context: ServerContext) => string;
  /** True only when a trusted host has established that this is an app call. */
  readonly isAppContext?: (context: ServerContext, toolName: string) => boolean;
  /** Generates a unique identifier for single-use request state. */
  readonly nextStateId?: () => string;
}

/** Result of the human confirmation gate. */
export type ConfirmationGateResult =
  | { readonly status: "allowed" }
  | { readonly status: "denied"; readonly code: string }
  | { readonly status: "input_required"; readonly result: InputRequiredResult };

/** One validated answer requested from a human through MCP elicitation. */
export interface HumanInputRequest<S extends z.ZodType> {
  readonly key: string;
  readonly answerSchema: S;
  readonly createRequest: (message: string) => ReturnType<typeof inputRequired.elicit>;
}

/** Result of a human elicitation that can carry a decision or other validated answer. */
export type HumanInputResult<T> =
  | { readonly status: "accepted"; readonly content: T }
  | { readonly status: "declined" }
  | { readonly status: "denied"; readonly code: string }
  | { readonly status: "input_required"; readonly result: InputRequiredResult };

/**
 * Enforces a single-use, argument-bound human confirmation using SDK-sealed MRTR state.
 *
 * MCP SDK 2.3.1 does not expose an app-origin marker to tool handlers. An app bypass therefore
 * requires an explicit trusted-host assertion; absent that, supported clients must confirm.
 */
export class ConfirmationGate {
  private readonly codec: ReturnType<typeof createRequestStateCodec>;
  private readonly now: () => number;
  private readonly tokenId: (context: ServerContext) => string;
  private readonly isAppContext: (context: ServerContext, toolName: string) => boolean;
  private readonly nextStateId: () => string;
  private readonly store: ConfirmationGateOptions["store"];

  /** Creates an HMAC-sealed confirmation gate. */
  constructor(options: ConfirmationGateOptions = {}) {
    this.now = options.now ?? Date.now;
    this.store = options.store;
    this.tokenId =
      options.tokenId ??
      ((context) => context.http?.authInfo?.clientId ?? context.sessionId ?? "local");
    this.isAppContext = options.isAppContext ?? (() => false);
    this.nextStateId = options.nextStateId ?? randomUUID;
    this.codec = createRequestStateCodec({
      key: options.key ?? DEFAULT_REQUEST_STATE_KEY,
      ttlSeconds: CONFIRMATION_TTL_SECONDS,
      bind: (context) => this.tokenId(context),
    });
  }

  /** Verifies echoed confirmation state before an MCP tool callback runs. */
  readonly verifyRequestState = (state: string, context: ServerContext): Promise<unknown> =>
    this.codec.verify(state, context);

  /**
   * Requires an app-host assertion or a fresh human-confirmed elicitation.
   * @param requestStateToken - Optional opaque token verified for hosts outside the SDK retry flow.
   */
  async requireHuman(
    context: ServerContext,
    request: ConfirmationRequest,
    requestStateToken?: string,
  ): Promise<ConfirmationGateResult> {
    if (this.isAppContext(context, request.toolName)) {
      return { status: "allowed" };
    }

    const result = await this.requireHumanInput(
      context,
      request,
      {
        key: "confirm",
        answerSchema: confirmSchema,
        createRequest: (message) =>
          inputRequired.elicit({
            message,
            requestedSchema: {
              type: "object",
              properties: { confirm: { type: "boolean" } },
              required: ["confirm"],
            },
          }),
      },
      requestStateToken,
    );
    if (result.status === "accepted") {
      return result.content.confirm
        ? { status: "allowed" }
        : { status: "denied", code: Code.parse("human_confirmation_declined") };
    }
    if (result.status === "declined") {
      return { status: "denied", code: Code.parse("human_confirmation_declined") };
    }
    return result;
  }

  /** Requests a schema-validated human answer using sealed, argument-bound MRTR state. */
  requireHumanInput<S extends z.ZodType>(
    context: ServerContext,
    request: ConfirmationRequest,
    elicitation: HumanInputRequest<S>,
    requestStateToken?: string,
  ): Promise<HumanInputResult<z.output<S>>> {
    return this.requestInput(context, request, elicitation, requestStateToken);
  }

  private async requestInput<S extends z.ZodType>(
    context: ServerContext,
    request: ConfirmationRequest,
    elicitation: HumanInputRequest<S>,
    requestStateToken?: string,
  ): Promise<HumanInputResult<z.output<S>>> {
    let stateValue: unknown;
    if (requestStateToken === undefined) {
      stateValue = context.mcpReq.requestState();
    } else {
      try {
        stateValue = await this.codec.verify(requestStateToken, context);
      } catch {
        return { status: "denied", code: Code.parse("confirmation_state_invalid") };
      }
      if (stateValue === undefined) {
        return { status: "denied", code: Code.parse("confirmation_state_invalid") };
      }
    }
    if (stateValue !== undefined) {
      return this.acceptRetry(context, request, stateValue, elicitation);
    }

    if (!supportsFormElicitation(request.clientCapabilities)) {
      return { status: "denied", code: Code.parse("human_confirmation_unavailable") };
    }

    const state = this.createState(context, request);
    const requestState = await this.codec.mint(state, context);
    return {
      status: "input_required",
      result: inputRequired({
        inputRequests: { [elicitation.key]: elicitation.createRequest(request.summary) },
        requestState,
      }),
    };
  }

  private createState(context: ServerContext, request: ConfirmationRequest): ConfirmationState {
    const now = this.now();
    return confirmationStateSchema.parse({
      stateId: this.nextStateId(),
      tokenId: this.tokenId(context),
      toolName: request.toolName,
      argumentsDigest: digestArguments(request.arguments),
      targetId: request.targetId,
      expiresAt: now + CONFIRMATION_TTL_SECONDS * 1_000,
    });
  }

  private async acceptRetry<S extends z.ZodType>(
    context: ServerContext,
    request: ConfirmationRequest,
    stateValue: unknown,
    elicitation: HumanInputRequest<S>,
  ): Promise<HumanInputResult<z.output<S>>> {
    const parsedState = confirmationStateSchema.safeParse(stateValue);
    if (!parsedState.success) {
      return { status: "denied", code: Code.parse("confirmation_state_invalid") };
    }
    const state = parsedState.data;
    const now = this.now();
    if (state.expiresAt <= now) {
      return { status: "denied", code: Code.parse("confirmation_state_mismatch") };
    }
    if (this.store === undefined) {
      return { status: "denied", code: Code.parse("confirmation_state_unavailable") };
    }
    let consumed: boolean;
    try {
      consumed = await this.store.consumeConfirmationState(state.stateId, state.expiresAt, now);
    } catch {
      return { status: "denied", code: Code.parse("confirmation_state_unavailable") };
    }
    if (!consumed) {
      return { status: "denied", code: Code.parse("confirmation_state_replayed") };
    }
    if (
      state.tokenId !== this.tokenId(context) ||
      state.toolName !== request.toolName ||
      state.targetId !== request.targetId ||
      state.argumentsDigest !== digestArguments(request.arguments)
    ) {
      return { status: "denied", code: Code.parse("confirmation_state_mismatch") };
    }

    return parseHumanAnswer(
      context.mcpReq.inputResponses,
      elicitation.key,
      elicitation.answerSchema,
    );
  }
}

function parseHumanAnswer<S extends z.ZodType>(
  inputResponses: ServerContext["mcpReq"]["inputResponses"],
  key: string,
  answerSchema: S,
): HumanInputResult<z.output<S>> {
  const responses = z.record(z.string(), z.unknown()).safeParse(inputResponses);
  const response = responses.success ? responses.data[key] : undefined;
  const action = z
    .looseObject({ action: z.enum(["accept", "decline", "cancel"]) })
    .safeParse(response);
  if (!action.success || action.data.action !== "accept") {
    return { status: "declined" };
  }
  const answer = acceptedContent(inputResponses, key, answerSchema);
  if (answer === undefined || answer === null) {
    return { status: "denied", code: Code.parse("human_input_invalid") };
  }
  const parsedAnswer = answerSchema.safeParse(answer);
  return parsedAnswer.success
    ? { status: "accepted", content: parsedAnswer.data }
    : { status: "denied", code: Code.parse("human_input_invalid") };
}

function supportsFormElicitation(
  capabilities: ConfirmationClientCapabilities | undefined,
): boolean {
  return capabilities?.elicitation?.form !== undefined;
}

function digestArguments(argumentsValue: Readonly<Record<string, unknown>>): string {
  return createHash("sha256")
    .update(canonicalJson(argumentsValue) ?? "null")
    .digest("hex");
}
