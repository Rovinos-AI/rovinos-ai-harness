// SPDX-License-Identifier: Apache-2.0
import { Code, Id } from "@harness/schemas";
import {
  acceptedContent,
  createRequestStateCodec,
  inputRequired,
  type ClientCapabilities,
  type InputRequiredResult,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";

const CONFIRMATION_TTL_SECONDS = 300;
const DEFAULT_REQUEST_STATE_KEY = randomBytes(32);
const confirmSchema = z.object({ confirm: z.boolean() }).strict();

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

/** Parameters that bind a human confirmation to one concrete tool call. */
export interface ConfirmationRequest {
  readonly toolName: string;
  readonly targetId: Id;
  readonly arguments: Readonly<Record<string, unknown>>;
  /** A summary containing only metadata and already-tokenized content. */
  readonly summary: string;
  readonly clientCapabilities: ClientCapabilities | undefined;
}

/** Options for the fail-closed confirmation gate. */
export interface ConfirmationGateOptions {
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

/**
 * Enforces a single-use, argument-bound human confirmation using SDK-sealed MRTR state.
 *
 * MCP SDK 2.3.1 does not expose an app-origin marker to tool handlers. An app bypass therefore
 * requires an explicit trusted-host assertion; absent that, supported clients must confirm.
 */
export class ConfirmationGate {
  private readonly codec: ReturnType<typeof createRequestStateCodec<ConfirmationState>>;
  private readonly now: () => number;
  private readonly tokenId: (context: ServerContext) => string;
  private readonly isAppContext: (context: ServerContext, toolName: string) => boolean;
  private readonly nextStateId: () => string;
  private readonly consumed = new Map<string, number>();

  /** Creates an HMAC-sealed confirmation gate. */
  constructor(options: ConfirmationGateOptions = {}) {
    this.now = options.now ?? Date.now;
    this.tokenId =
      options.tokenId ??
      ((context) => context.http?.authInfo?.clientId ?? context.sessionId ?? "local");
    this.isAppContext = options.isAppContext ?? (() => false);
    this.nextStateId = options.nextStateId ?? randomUUID;
    this.codec = createRequestStateCodec<ConfirmationState>({
      key: options.key ?? DEFAULT_REQUEST_STATE_KEY,
      ttlSeconds: CONFIRMATION_TTL_SECONDS,
      bind: (context) => this.tokenId(context),
    });
  }

  /** Verifies echoed confirmation state before an MCP tool callback runs. */
  readonly verifyRequestState = (state: string, context: ServerContext): Promise<unknown> =>
    this.codec.verify(state, context);

  /** Requires an app-host assertion or a fresh human-confirmed elicitation. */
  async requireHuman(
    context: ServerContext,
    request: ConfirmationRequest,
  ): Promise<ConfirmationGateResult> {
    if (this.isAppContext(context, request.toolName)) {
      return { status: "allowed" };
    }

    const stateValue = context.mcpReq.requestState<unknown>();
    if (stateValue !== undefined) {
      return this.acceptRetry(context, request, stateValue);
    }

    if (!supportsFormElicitation(request.clientCapabilities)) {
      return { status: "denied", code: Code.parse("human_confirmation_unavailable") };
    }

    const now = this.now();
    const state = confirmationStateSchema.parse({
      stateId: this.nextStateId(),
      tokenId: this.tokenId(context),
      toolName: request.toolName,
      argumentsDigest: digestArguments(request.arguments),
      targetId: request.targetId,
      expiresAt: now + CONFIRMATION_TTL_SECONDS * 1_000,
    });
    const requestState = await this.codec.mint(state, context);
    return {
      status: "input_required",
      result: inputRequired({
        inputRequests: {
          confirm: inputRequired.elicit({
            message: request.summary,
            requestedSchema: {
              type: "object",
              properties: { confirm: { type: "boolean" } },
              required: ["confirm"],
            },
          }),
        },
        requestState,
      }),
    };
  }

  private acceptRetry(
    context: ServerContext,
    request: ConfirmationRequest,
    stateValue: unknown,
  ): ConfirmationGateResult {
    const parsedState = confirmationStateSchema.safeParse(stateValue);
    if (!parsedState.success) {
      return { status: "denied", code: Code.parse("confirmation_state_invalid") };
    }
    const state = parsedState.data;
    this.expireConsumedStates();
    if (this.consumed.has(state.stateId)) {
      return { status: "denied", code: Code.parse("confirmation_state_replayed") };
    }
    this.consumed.set(state.stateId, state.expiresAt);
    if (
      state.expiresAt <= this.now() ||
      state.tokenId !== this.tokenId(context) ||
      state.toolName !== request.toolName ||
      state.targetId !== request.targetId ||
      state.argumentsDigest !== digestArguments(request.arguments)
    ) {
      return { status: "denied", code: Code.parse("confirmation_state_mismatch") };
    }

    const answer = acceptedContent(context.mcpReq.inputResponses, "confirm", confirmSchema);
    if (answer?.confirm !== true) {
      return { status: "denied", code: Code.parse("human_confirmation_declined") };
    }
    return { status: "allowed" };
  }

  private expireConsumedStates(): void {
    const now = this.now();
    for (const [stateId, expiresAt] of this.consumed) {
      if (expiresAt <= now) {
        this.consumed.delete(stateId);
      }
    }
  }
}

function supportsFormElicitation(capabilities: ClientCapabilities | undefined): boolean {
  return capabilities?.elicitation?.form !== undefined;
}

function digestArguments(argumentsValue: Readonly<Record<string, unknown>>): string {
  return createHash("sha256").update(JSON.stringify(argumentsValue)).digest("hex");
}
