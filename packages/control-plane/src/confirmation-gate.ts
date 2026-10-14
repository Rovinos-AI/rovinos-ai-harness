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

  /** Requires an app-host assertion or a fresh human-confirmed elicitation. */
  async requireHuman(
    context: ServerContext,
    request: ConfirmationRequest,
  ): Promise<ConfirmationGateResult> {
    if (this.isAppContext(context, request.toolName)) {
      return { status: "allowed" };
    }

    const stateValue = context.mcpReq.requestState();
    if (stateValue !== undefined) {
      return this.acceptRetry(context, request, stateValue);
    }

    if (!supportsFormElicitation(request.clientCapabilities)) {
      return { status: "denied", code: Code.parse("human_confirmation_unavailable") };
    }

    const now = this.now();
    const state: ConfirmationState = confirmationStateSchema.parse({
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

  private async acceptRetry(
    context: ServerContext,
    request: ConfirmationRequest,
    stateValue: unknown,
  ): Promise<ConfirmationGateResult> {
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

    const answer = acceptedContent(context.mcpReq.inputResponses, "confirm", confirmSchema);
    if (answer?.confirm !== true) {
      return { status: "denied", code: Code.parse("human_confirmation_declined") };
    }
    return { status: "allowed" };
  }
}

function supportsFormElicitation(
  capabilities: ConfirmationClientCapabilities | undefined,
): boolean {
  return capabilities?.elicitation?.form !== undefined;
}

function digestArguments(argumentsValue: Readonly<Record<string, unknown>>): string {
  return createHash("sha256").update(canonicalJson(argumentsValue) ?? "null").digest("hex");
}
