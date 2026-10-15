// SPDX-License-Identifier: Apache-2.0
import {
  ApprovalPayloadSchema,
  Code,
  Id,
  ResolveRequest,
  ResolveResponse,
  RevealRequest,
  RevealResponse,
  type JsonValue,
} from "@harness/schemas";
import type { AuditingVaultResolver } from "@harness/vault";
import { Token } from "@harness/vault";
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import type { ConfirmationClientCapabilities, ConfirmationGate } from "../confirmation-gate.js";
import { findApprovalRequest, readRunState } from "./run-state.js";
import type { EventStore } from "@harness/store";
import type { ResolveApprovalOperation } from "./approve.js";
import { applyApprovalEdits, approvalEditsAreAllowed } from "@harness/policy";
import { z } from "zod";

const TOOL_RESOLVE = Code.parse("harness.approvals.resolve");
const TOOL_REVEAL = Code.parse("harness.approvals.reveal");
const unknownTokenId = Code.parse("unknown");

/** Scope required by an app-only approval operation. */
export type ApprovalAppScope = "approve" | "reveal";

/** Result of checking a caller scope and run filter. */
export interface ApprovalAppAuthorization {
  readonly allowed: boolean;
  readonly tokenId: Code;
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
  readonly requireRevealElicitation?: boolean;
  readonly now?: () => number;
  readonly onAudit?: (audit: ApprovalAppAudit) => void;
}

interface RateWindow {
  readonly timestamps: number[];
}

/** Registers strict app-only resolve and reveal tools. */
export function registerApprovalAppTools(server: McpServer, options: ApprovalAppToolOptions): void {
  const sessions = new Map<string, RateWindow>();
  server.registerTool(
    TOOL_RESOLVE,
    {
      description: "Resolve a pending approval from its human review view.",
      inputSchema: ResolveRequest,
      outputSchema: ResolveResponse,
      annotations: { openWorldHint: false },
      _meta: { ui: { visibility: ["app"] } },
    },
    async (input, context) => {
      const request = ResolveRequest.parse(input);
      const found = await findApprovalRequest(options.store, request.approvalId);
      if (found === undefined) {
        return decisionResult(options, unknownTokenId, TOOL_RESOLVE, false, "approval_not_found");
      }
      const access = await authorize(options, context, "approve", found.runId);
      if (!access.allowed) {
        return decisionResult(options, access.tokenId, TOOL_RESOLVE, false, "approval_not_found");
      }
      if (found.resolved) {
        return decisionResult(
          options,
          access.tokenId,
          TOOL_RESOLVE,
          false,
          "approval_already_resolved",
        );
      }
      const run = await readRunState(options.store, found.runId);
      if (run === undefined || !run.state.pendingApprovals.has(request.approvalId)) {
        return decisionResult(
          options,
          access.tokenId,
          TOOL_RESOLVE,
          false,
          "approval_not_found",
        );
      }
      const gate = await options.confirmationGate.requireHuman(context, {
        toolName: TOOL_RESOLVE,
        targetId: request.approvalId,
        arguments: request,
        summary: `Resolve approval ${request.approvalId}?`,
        clientCapabilities: options.clientCapabilities(context),
      });
      if (gate.status === "input_required") {
        return gate.result;
      }
      if (gate.status === "denied") {
        return decisionResult(options, access.tokenId, TOOL_RESOLVE, false, gate.code);
      }
      if (options.resolveApproval === undefined) {
        return decisionResult(
          options,
          access.tokenId,
          TOOL_RESOLVE,
          false,
          "control_plane_runtime_unavailable",
        );
      }
      const decision: "approve" | "deny" | "edit" = request.decision;
      let edits: JsonValue | undefined;
      if (request.decision === "edit") {
        const payload = ApprovalPayloadSchema.safeParse(found.request.payload);
        const applied =
          payload.success &&
          request.edits !== undefined &&
          approvalEditsAreAllowed(payload.data, request.edits)
            ? applyApprovalEdits(payload.data.args, request.edits)
            : { success: false as const };
        if (!applied.success) {
          return decisionResult(options, access.tokenId, TOOL_RESOLVE, false, "edit_not_allowed");
        }
        edits = applied.args;
      }
      try {
        await options.resolveApproval({
          runId: found.runId,
          approvalId: request.approvalId,
          decision,
          ...(edits === undefined ? {} : { edits }),
        });
        return decisionResult(options, access.tokenId, TOOL_RESOLVE, true);
      } catch (error) {
        return decisionResult(
          options,
          access.tokenId,
          TOOL_RESOLVE,
          false,
          safeErrorCode(error),
        );
      }
    },
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
    async (input, context) => {
      const request = RevealRequest.parse(input);
      if (options.allowReveal !== true) {
        return revealResult(options, unknownTokenId, false, "reveal_disabled", []);
      }
      const found = await findApprovalRequest(options.store, request.approvalId);
      if (found === undefined || found.resolved) {
        return revealResult(options, unknownTokenId, false, "approval_not_found", []);
      }
      const access = await authorize(options, context, "reveal", found.runId);
      if (!access.allowed) {
        return revealResult(options, access.tokenId, false, "approval_not_found", []);
      }
      const run = await readRunState(options.store, found.runId);
      const payload = ApprovalPayloadSchema.safeParse(found.request.payload);
      if (
        run === undefined ||
        !run.state.pendingApprovals.has(request.approvalId) ||
        !payload.success
      ) {
        return revealResult(options, access.tokenId, false, "approval_not_found", []);
      }
      if (options.vaultResolver === undefined) {
        return revealResult(
          options,
          access.tokenId,
          false,
          "reveal_unavailable",
          [],
        );
      }
      const sessionId = context.sessionId ?? "local";
      const now = Math.floor((options.now ?? Date.now)());
      if (!acceptRevealRequest(sessions, sessionId, now)) {
        return revealResult(options, access.tokenId, false, "rate_limited", []);
      }
      if (options.requireRevealElicitation !== false) {
        const gate = await options.confirmationGate.requireHuman(context, {
          toolName: TOOL_REVEAL,
          targetId: request.approvalId,
          arguments: request,
          summary: `Reveal ${String(request.pointers.length)} values from approval ${request.approvalId}?`,
          clientCapabilities: options.clientCapabilities(context),
        });
        if (gate.status === "input_required") {
          return gate.result;
        }
        if (gate.status === "denied") {
          return revealResult(options, access.tokenId, false, gate.code, []);
        }
      }
      const selected = request.pointers.map((pointer) => ({
        pointer,
        token: findValueAtPointer(payload.data.args, pointer),
      }));
      if (selected.some(({ token }) => typeof token !== "string" || !Token.safeParse(token).success)) {
        return revealResult(options, access.tokenId, false, "pointer_invalid", []);
      }
      const tokens = selected.map(({ token }) => Token.parse(token));
      try {
        const values = await options.vaultResolver.resolveMany(
          found.runId,
          tokens,
          { boundary: "ui" },
        );
        if (values.some((value) => value === undefined)) {
          return revealResult(
            options,
            access.tokenId,
            false,
            "reveal_value_unavailable",
            [],
          );
        }
        const revealed = selected.flatMap(({ pointer }, index) => {
          const value = values[index];
          return value === undefined ? [] : [{ pointer, value }];
        });
        return revealResult(options, access.tokenId, true, undefined, revealed);
      } catch (error) {
        return revealResult(options, access.tokenId, false, safeErrorCode(error), []);
      }
    },
  );
}

function acceptRevealRequest(
  sessions: Map<string, RateWindow>,
  sessionId: string,
  now: number,
): boolean {
  for (const [key, window] of sessions) {
    if (window.timestamps.every((timestamp) => timestamp <= now - 60_000)) {
      sessions.delete(key);
    }
  }
  if (!sessions.has(sessionId) && sessions.size >= 1_024) {
    return false;
  }
  const window = sessions.get(sessionId) ?? { timestamps: [] };
  const recent = window.timestamps.filter((timestamp) => timestamp > now - 60_000);
  if (recent.length >= 5) {
    sessions.set(sessionId, { timestamps: recent });
    return false;
  }
  recent.push(now);
  sessions.set(sessionId, { timestamps: recent });
  return true;
}

async function authorize(
  options: ApprovalAppToolOptions,
  context: ServerContext,
  scope: ApprovalAppScope,
  runId: Id,
): Promise<ApprovalAppAuthorization> {
  if (options.authorize === undefined) {
    return { allowed: false, tokenId: unknownTokenId };
  }
  return options.authorize(context, scope, runId);
}

function findValueAtPointer(value: JsonValue, pointer: string): JsonValue | undefined {
  if (pointer.length === 0) {
    return undefined;
  }
  let current: JsonValue | undefined = value;
  for (const segment of pointer
    .slice(1)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))) {
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/u.test(segment)) {
        return undefined;
      }
      const index = Number(segment);
      current = Number.isSafeInteger(index) && index >= 0 ? current[index] : undefined;
    } else if (
      typeof current === "object" &&
      current !== null &&
      Object.hasOwn(current, segment)
    ) {
      current = current[segment];
    } else {
      return undefined;
    }
    if (current === undefined) {
      return undefined;
    }
  }
  return current;
}

function decisionResult(
  options: ApprovalAppToolOptions,
  tokenId: Code,
  tool: Code,
  ok: boolean,
  code?: string,
) {
  const output = ResolveResponse.parse({
    ok,
    ...(code === undefined ? {} : { code: Code.parse(code) }),
  });
  audit(options, { tokenId, tool, outcome: Code.parse(code ?? (ok ? "ok" : "failed")), count: 0 });
  return {
    structuredContent: output,
    content: [{ type: "text" as const, text: code ?? (ok ? "Decision recorded." : "No change.") }],
    ...(ok ? {} : { isError: true }),
  };
}

function revealResult(
  options: ApprovalAppToolOptions,
  tokenId: Code,
  ok: boolean,
  code: string | undefined,
  values: RevealResponse["values"],
) {
  const output = RevealResponse.parse({ values: ok ? values : [] });
  audit(options, {
    tokenId,
    tool: TOOL_REVEAL,
    outcome: Code.parse(code ?? (ok ? "ok" : "failed")),
    count: values.length,
  });
  return {
    structuredContent: output,
    content: [{ type: "text" as const, text: code ?? `Revealed ${String(values.length)} values.` }],
    ...(ok ? {} : { isError: true }),
  };
}

function audit(options: ApprovalAppToolOptions, entry: ApprovalAppAudit): void {
  try {
    options.onAudit?.(entry);
  } catch {
    return;
  }
}

function safeErrorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const parsed = Code.safeParse(error.code);
    if (parsed.success) {
      return parsed.data;
    }
  }
  return "approval_operation_failed";
}
