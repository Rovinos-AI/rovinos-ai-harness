// SPDX-License-Identifier: Apache-2.0
import {
  ApprovalPayloadSchema,
  ApprovalAppGetRequestSchema,
  ApprovalAppInputSchema,
  Code,
  ResolveRequest,
  ResolveResponse,
  RevealRequest,
  RevealResponse,
  type Id,
  type Principal,
} from "@harness/schemas";
import type { AuditingVaultResolver } from "@harness/vault";
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import type { ConfirmationClientCapabilities, ConfirmationGate } from "../confirmation-gate.js";
import {
  auditInputRequired,
  decisionResult,
  requireHumanConfirmation,
  resolveSelectedValues,
  resolveRequestedEdits,
  revealResult,
  safeErrorCode,
} from "./approval-app-helpers.js";
import { findApprovalRequest, readRunState } from "./run-state.js";
import type { EventStore } from "@harness/store";
import type { ResolveApprovalOperation } from "./approve.js";
import { z } from "zod";

const TOOL_RESOLVE = Code.parse("harness.approvals.resolve");
const TOOL_REVEAL = Code.parse("harness.approvals.reveal");
const TOOL_GET = Code.parse("harness.approvals.get");
const unknownTokenId = Code.parse("unknown");

/** Scope required by an app-only approval operation. */
export type ApprovalAppScope = "approve" | "reveal";

/** Result of checking a caller scope and run filter. */
export interface ApprovalAppAuthorization {
  readonly allowed: boolean;
  readonly tokenId: Code;
  readonly principal: Principal;
}

/** Metadata-only audit entry emitted for each app-only approval operation. */
export interface ApprovalAppAudit {
  readonly tokenId: Code;
  readonly tool: Code;
  readonly outcome: Code;
  readonly count: number;
}

/** Dependencies for the app-only approval tools. */
export interface ApprovalAppToolOptions {
  readonly store: EventStore;
  readonly resolveApproval?: ResolveApprovalOperation;
  readonly vaultResolver?: AuditingVaultResolver;
  readonly confirmationGate: ConfirmationGate;
  readonly clientCapabilities: (
    context: ServerContext,
  ) => ConfirmationClientCapabilities | undefined;
  readonly authorize?: (
    context: ServerContext,
    scope: ApprovalAppScope,
    runId: Id,
  ) => Promise<ApprovalAppAuthorization> | ApprovalAppAuthorization;
  readonly allowReveal?: boolean;
  readonly revealRateLimiter: ApprovalAppRevealRateLimiter;
  readonly now?: () => number;
  readonly onAudit: (audit: ApprovalAppAudit) => void;
}

interface RateWindow {
  readonly timestamps: number[];
}

/** Listener-owned, caller/session-scoped limit for approval reveals. */
export class ApprovalAppRevealRateLimiter {
  private readonly sessions = new Map<string, RateWindow>();

  /** Accepts at most five reveals per minute for one authenticated token and MCP session. */
  tryAcquire(tokenId: Code, sessionId: string, now: number): boolean {
    for (const [key, window] of this.sessions) {
      if (window.timestamps.every((timestamp) => timestamp <= now - 60_000)) {
        this.sessions.delete(key);
      }
    }
    const key = JSON.stringify([tokenId, sessionId]);
    if (!this.sessions.has(key) && this.sessions.size >= 1_024) {
      return false;
    }
    const window = this.sessions.get(key) ?? { timestamps: [] };
    const recent = window.timestamps.filter((timestamp) => timestamp > now - 60_000);
    if (recent.length >= 5) {
      this.sessions.set(key, { timestamps: recent });
      return false;
    }
    recent.push(now);
    this.sessions.set(key, { timestamps: recent });
    return true;
  }
}

/** Registers strict app-only approval payload, resolve, and reveal tools. */
export function registerApprovalAppTools(server: McpServer, options: ApprovalAppToolOptions): void {
  server.registerTool(
    TOOL_GET,
    {
      description: "Load one pending approval into its human review view.",
      inputSchema: ApprovalAppGetRequestSchema,
      outputSchema: ApprovalAppInputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      _meta: { ui: { visibility: ["app"] } },
    },
    (input, context) => handleGetApprovalRequest(options, input, context),
  );
  server.registerTool(
    TOOL_RESOLVE,
    {
      description: "Resolve a pending approval from its human review view.",
      inputSchema: ResolveRequest,
      outputSchema: ResolveResponse,
      annotations: { openWorldHint: false },
      _meta: { ui: { visibility: ["app"] } },
    },
    (input, context) => handleResolveRequest(options, input, context),
  );
  server.registerTool(
    TOOL_REVEAL,
    {
      description: "Reveal selected approval argument values after authorization.",
      inputSchema: RevealRequest,
      outputSchema: z.toJSONSchema(RevealResponse),
      annotations: { openWorldHint: false },
      _meta: { ui: { visibility: ["app"] } },
    },
    (input, context) => handleRevealRequest(options, input, context),
  );
}

async function handleGetApprovalRequest(
  options: ApprovalAppToolOptions,
  input: unknown,
  context: ServerContext,
) {
  const request = ApprovalAppGetRequestSchema.parse(input);
  const pending = await findAccessiblePendingApproval({
    options,
    context,
    approvalId: request.approvalId,
    scope: "approve",
  });
  if (!pending.success) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: "approval_not_found" }],
    };
  }
  const payload = ApprovalPayloadSchema.safeParse(pending.found.request.payload);
  if (!payload.success) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: "approval_not_found" }],
    };
  }
  const output = ApprovalAppInputSchema.parse({
    approvalId: request.approvalId,
    payload: payload.data,
  });
  return {
    structuredContent: output,
    content: [{ type: "text" as const, text: "Approval payload ready." }],
  };
}

type FoundApproval = NonNullable<Awaited<ReturnType<typeof findApprovalRequest>>>;

type PendingApprovalAccess =
  | {
      readonly success: true;
      readonly found: FoundApproval;
      readonly tokenId: Code;
      readonly principal: Principal;
    }
  | { readonly success: false; readonly tokenId: Code; readonly code: string };

async function findAccessiblePendingApproval(input: {
  readonly options: ApprovalAppToolOptions;
  readonly context: ServerContext;
  readonly approvalId: Id;
  readonly scope: ApprovalAppScope;
}): Promise<PendingApprovalAccess> {
  const found = await findApprovalRequest(input.options.store, input.approvalId);
  if (found === undefined) {
    return { success: false, tokenId: unknownTokenId, code: "approval_not_found" };
  }
  const access = await authorize(input.options, input.context, input.scope, found.runId);
  if (!access.allowed) {
    return { success: false, tokenId: access.tokenId, code: "approval_not_found" };
  }
  if (found.resolved) {
    return {
      success: false,
      tokenId: access.tokenId,
      code: input.scope === "approve" ? "approval_already_resolved" : "approval_not_found",
    };
  }
  const run = await readRunState(input.options.store, found.runId);
  if (run?.state.pendingApprovals.has(input.approvalId) !== true) {
    return { success: false, tokenId: access.tokenId, code: "approval_not_found" };
  }
  return { success: true, found, tokenId: access.tokenId, principal: access.principal };
}

async function handleResolveRequest(
  options: ApprovalAppToolOptions,
  input: unknown,
  context: ServerContext,
) {
  const request = ResolveRequest.parse(input);
  const pending = await findAccessiblePendingApproval({
    options,
    context,
    approvalId: request.approvalId,
    scope: "approve",
  });
  if (!pending.success) {
    return resolveFailure(options, pending.tokenId, pending.code);
  }
  const { found, tokenId, principal } = pending;
  const gate = await requireApprovalConfirmation({
    options,
    context,
    tokenId,
    tool: TOOL_RESOLVE,
    request: {
      toolName: TOOL_RESOLVE,
      targetId: request.approvalId,
      arguments: request,
      summary: `Resolve approval ${request.approvalId}?`,
    },
  });
  if (gate.status === "input_required") {
    return gate.result;
  }
  if (gate.status === "denied") {
    return resolveFailure(options, tokenId, gate.code);
  }
  if (options.resolveApproval === undefined) {
    return resolveFailure(options, tokenId, "control_plane_runtime_unavailable");
  }
  const applied = resolveRequestedEdits(found, request);
  if (!applied.success) {
    return resolveFailure(options, tokenId, "edit_not_allowed");
  }
  try {
    await options.resolveApproval({
      runId: found.runId,
      approvalId: request.approvalId,
      decision: request.decision,
      approverId: principal,
      ...(applied.edits === undefined ? {} : { edits: applied.edits }),
    });
    return decisionResult(options, {
      tokenId,
      tool: TOOL_RESOLVE,
      ok: true,
    });
  } catch (error) {
    return decisionResult(options, {
      tokenId,
      tool: TOOL_RESOLVE,
      ok: false,
      code: safeErrorCode(error),
    });
  }
}

async function handleRevealRequest(
  options: ApprovalAppToolOptions,
  input: unknown,
  context: ServerContext,
) {
  const request = RevealRequest.parse(input);
  if (options.allowReveal !== true) {
    return revealFailure(options, unknownTokenId, "reveal_disabled");
  }
  const pending = await findAccessiblePendingApproval({
    options,
    context,
    approvalId: request.approvalId,
    scope: "reveal",
  });
  if (!pending.success) {
    return revealFailure(options, pending.tokenId, pending.code);
  }
  const { found, tokenId } = pending;
  const payload = ApprovalPayloadSchema.safeParse(found.request.payload);
  if (!payload.success) {
    return revealFailure(options, tokenId, "approval_not_found");
  }
  if (options.vaultResolver === undefined) {
    return revealFailure(options, tokenId, "reveal_unavailable");
  }
  const sessionId = context.sessionId ?? "local";
  const now = Math.floor((options.now ?? Date.now)());
  if (!options.revealRateLimiter.tryAcquire(tokenId, sessionId, now)) {
    return revealFailure(options, tokenId, "rate_limited");
  }
  const gate = await requireApprovalConfirmation({
    options,
    context,
    tokenId,
    tool: TOOL_REVEAL,
    request: {
      toolName: TOOL_REVEAL,
      targetId: request.approvalId,
      arguments: request,
      summary: `Reveal ${String(request.pointers.length)} values from approval ${request.approvalId}?`,
    },
  });
  if (gate.status === "input_required") {
    return gate.result;
  }
  if (gate.status === "denied") {
    return revealFailure(options, tokenId, gate.code);
  }
  const result = await resolveSelectedValues({
    vaultResolver: options.vaultResolver,
    runId: found.runId,
    args: payload.data.args,
    toolId: payload.data.toolId,
    pointers: request.pointers,
  });
  return revealResult(options, {
    tokenId,
    ok: result.success,
    ...(result.success ? {} : { code: result.code }),
    values: result.success ? result.values : [],
  });
}

function resolveFailure(options: ApprovalAppToolOptions, tokenId: Code, code: string) {
  return decisionResult(options, { tokenId, tool: TOOL_RESOLVE, ok: false, code });
}

function revealFailure(options: ApprovalAppToolOptions, tokenId: Code, code: string) {
  return revealResult(options, { tokenId, ok: false, code, values: [] });
}

async function requireApprovalConfirmation(input: {
  readonly options: ApprovalAppToolOptions;
  readonly context: ServerContext;
  readonly tokenId: Code;
  readonly tool: Code;
  readonly request: Parameters<typeof requireHumanConfirmation>[2];
}): Promise<Awaited<ReturnType<ConfirmationGate["requireHuman"]>>> {
  const result = await requireHumanConfirmation(input.options, input.context, input.request);
  if (result.status === "input_required") {
    auditInputRequired(input.options, input.tokenId, input.tool);
  }
  return result;
}

async function authorize(
  options: ApprovalAppToolOptions,
  context: ServerContext,
  scope: ApprovalAppScope,
  runId: Id,
): Promise<ApprovalAppAuthorization> {
  if (options.authorize === undefined) {
    return { allowed: false, tokenId: unknownTokenId, principal: "cli.control_plane" };
  }
  return options.authorize(context, scope, runId);
}
