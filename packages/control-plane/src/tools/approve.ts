// SPDX-License-Identifier: Apache-2.0
import { Code, type Id, type JsonValue, type Principal } from "@rovinos/schemas";
import type { EventStore } from "@rovinos/store";
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import type { ControlPlaneAuditHandler } from "../auth.js";
import { requireControlPlaneScope, withControlPlaneAuthorization } from "../auth.js";
import type { ConfirmationClientCapabilities, ConfirmationGate } from "../confirmation-gate.js";
import { approveInputSchema, decisionOutputSchema } from "../schemas.js";
import type { ApprovalDecision } from "@rovinos/core";
import { findApprovalRequest } from "./run-state.js";

/** One validated approval resolution request. */
export interface ResolveApprovalRequest {
  readonly runId: Id;
  readonly approvalId: Id;
  readonly decision: ApprovalDecision;
  readonly approverId: Principal;
  readonly edits?: JsonValue;
  readonly reason?: Code;
}

/** Executes one validated approval resolution. */
export type ResolveApprovalOperation = (request: ResolveApprovalRequest) => Promise<unknown>;

/** Dependencies for the `approve` tool. */
export interface ApproveToolOptions {
  readonly store: EventStore;
  readonly confirmationGate: ConfirmationGate;
  readonly resolveApproval?: ResolveApprovalOperation;
  readonly clientCapabilities: (
    context: ServerContext,
  ) => ConfirmationClientCapabilities | undefined;
  readonly onAudit?: ControlPlaneAuditHandler;
}

/** Registers the app-only `approve` tool. */
export function registerApproveTool(server: McpServer, options: ApproveToolOptions): void {
  server.registerTool(
    "approve",
    {
      description: "Approve a pending approval without resuming its run.",
      inputSchema: approveInputSchema,
      outputSchema: decisionOutputSchema,
      annotations: { idempotentHint: false, openWorldHint: false },
      _meta: { ui: { visibility: ["app"] } },
    },
    async (input, context) => {
      const parsed = approveInputSchema.parse(input);
      const principal = requireControlPlaneScope(
        context,
        Code.parse("approve"),
        "approve",
        options.onAudit,
      );
      const found = await findApprovalRequest(options.store, parsed.approvalId, principal?.runIds);
      return withControlPlaneAuthorization({
        context,
        tool: Code.parse("approve"),
        scope: "approve",
        ...(found === undefined ? {} : { runId: found.runId }),
        operation: async () => {
          if (found === undefined) {
            return decisionResult(false, "approval_not_found");
          }
          if (found.resolved) {
            return decisionResult(false, "approval_already_resolved");
          }
          const gate = await options.confirmationGate.requireHuman(context, {
            toolName: "approve",
            targetId: parsed.approvalId,
            arguments: parsed,
            summary: `Approve request ${parsed.approvalId}?`,
            clientCapabilities: options.clientCapabilities(context),
          });
          if (gate.status === "input_required") {
            return gate.result;
          }
          if (gate.status === "denied") {
            return decisionResult(false, gate.code);
          }
          if (options.resolveApproval === undefined) {
            return decisionResult(false, "control_plane_runtime_unavailable");
          }

          try {
            await options.resolveApproval({
              runId: found.runId,
              approvalId: parsed.approvalId,
              decision: parsed.edits === undefined ? "approve" : "edit",
              approverId:
                principal === undefined ? "cli.control_plane" : `token.${principal.tokenId}`,
              ...(parsed.edits === undefined ? {} : { edits: parsed.edits }),
            });
            return decisionResult(true);
          } catch (error) {
            return decisionResult(false, safeErrorCode(error));
          }
        },
        audit: options.onAudit,
      });
    },
  );
}

function decisionResult(ok: boolean, code?: string) {
  const output = decisionOutputSchema.parse({
    ok,
    ...(code === undefined ? {} : { code: Code.parse(code) }),
  });
  return {
    structuredContent: output,
    content: [{ type: "text" as const, text: code ?? (ok ? "Decision recorded." : "No change.") }],
    ...(ok ? {} : { isError: true }),
  };
}

function safeErrorCode(error: unknown): Code {
  if (typeof error === "object" && error !== null && "code" in error) {
    const parsed = Code.safeParse(error.code);
    if (parsed.success) {
      return parsed.data;
    }
  }
  return Code.parse("approval_resolution_failed");
}
