// SPDX-License-Identifier: Apache-2.0
import { ApprovalPayloadSchema, Code } from "@harness/schemas";
import type { EventStore } from "@harness/store";
import { inputRequired, type McpServer, type ServerContext } from "@modelcontextprotocol/server";
import type { ControlPlaneAuditHandler } from "../auth.js";
import { requireControlPlaneScope, withControlPlaneAuthorization } from "../auth.js";
import type {
  ConfirmationClientCapabilities,
  ConfirmationGate,
  ConfirmationRequest,
  HumanInputResult,
} from "../confirmation-gate.js";
import {
  reviewApprovalDecisionSchema,
  reviewApprovalInputSchema,
  reviewApprovalOutputSchema,
  type ReviewApprovalDecision,
} from "../schemas.js";
import type { ResolveApprovalOperation } from "./approve.js";
import { findApprovalRequest } from "./run-state.js";

/** Dependencies for the model-visible review tool; the optional URL supports hosted consoles. */
export interface ReviewApprovalToolOptions {
  readonly store: EventStore;
  readonly confirmationGate: ConfirmationGate;
  readonly resolveApproval?: ResolveApprovalOperation;
  readonly clientCapabilities: (
    context: ServerContext,
  ) => ConfirmationClientCapabilities | undefined;
  readonly consoleUrl?: string;
  readonly onAudit?: ControlPlaneAuditHandler;
}

/** Registers a model-visible approval path that always requires a human decision. */
export function registerReviewApprovalTool(
  server: McpServer,
  options: ReviewApprovalToolOptions,
): void {
  server.registerTool(
    "review_approval",
    {
      description: "Ask a human to approve or deny a pending approval.",
      inputSchema: reviewApprovalInputSchema,
      outputSchema: reviewApprovalOutputSchema,
      annotations: { openWorldHint: false },
    },
    (input, context) => handleReviewApproval(options, input, context),
  );
}

async function handleReviewApproval(
  options: ReviewApprovalToolOptions,
  input: unknown,
  context: ServerContext,
) {
  const parsed = reviewApprovalInputSchema.parse(input);
  const principal = requireControlPlaneScope(
    context,
    Code.parse("review_approval"),
    "approve",
    options.onAudit,
  );
  const found = await findApprovalRequest(options.store, parsed.approvalId, principal?.runIds);
  return withControlPlaneAuthorization({
    context,
    tool: Code.parse("review_approval"),
    scope: "approve",
    ...(found === undefined ? {} : { runId: found.runId }),
    operation: async () => {
      if (found === undefined || found.resolved) {
        return reviewResult(
          false,
          found === undefined ? "approval_not_found" : "approval_already_resolved",
          true,
        );
      }
      const payload = ApprovalPayloadSchema.safeParse(found.request.payload);
      if (!payload.success) {
        return reviewResult(false, "approval_not_found", true);
      }
      const request: ConfirmationRequest = {
        toolName: "review_approval",
        targetId: parsed.approvalId,
        arguments: parsed,
        summary: payload.data.ui.fallbackText,
        clientCapabilities: options.clientCapabilities(context),
      };
      const result = await elicitDecision(options.confirmationGate, context, request);
      if (result.status === "input_required") {
        return result.result;
      }
      if (result.status === "denied" && result.code === "human_confirmation_unavailable") {
        return reviewResult(
          false,
          fallbackInstructions(
            parsed.approvalId,
            payload.data.editableFields.length > 0,
            options.consoleUrl,
          ),
        );
      }
      if (result.status === "denied") {
        return reviewResult(false, result.code, true);
      }
      if (result.status === "declined") {
        return reviewResult(false, "No decision was applied.");
      }
      if (options.resolveApproval === undefined) {
        return reviewResult(false, "control_plane_runtime_unavailable", true);
      }
      try {
        await options.resolveApproval({
          runId: found.runId,
          approvalId: parsed.approvalId,
          decision: result.content.decision,
          approverId: principal === undefined ? "cli.control_plane" : `token.${principal.tokenId}`,
          ...(result.content.decision === "deny" && result.content.reason !== undefined
            ? { reason: result.content.reason }
            : {}),
        });
        return reviewResult(true, "Decision recorded.");
      } catch (error) {
        return reviewResult(false, safeErrorCode(error), true);
      }
    },
    audit: options.onAudit,
  });
}

/** Requests an approval decision in an elicitation form with no edit fields. */
export function elicitDecision(
  gate: ConfirmationGate,
  context: ServerContext,
  request: ConfirmationRequest,
): Promise<HumanInputResult<ReviewApprovalDecision>> {
  return gate.requireHumanInput(context, request, {
    key: "decision",
    answerSchema: reviewApprovalDecisionSchema,
    createRequest: (message) =>
      inputRequired.elicit({
        message,
        requestedSchema: {
          type: "object",
          properties: {
            decision: { type: "string", enum: ["approve", "deny"] },
            reason: { type: "string" },
          },
          required: ["decision"],
        },
      }),
  });
}

function fallbackInstructions(
  approvalId: string,
  supportsEdits: boolean,
  consoleUrl: string | undefined,
): string {
  const editInstruction = supportsEdits
    ? ` This approval permits edits; use the CLI with --edit <json-file> or the approval app.`
    : "";
  const consoleInstruction =
    consoleUrl === undefined ? "" : ` Open the control-plane console: ${consoleUrl}`;
  return `Human input is unavailable. Use the CLI: harness approvals approve ${approvalId}.${editInstruction}${consoleInstruction}`;
}

function reviewResult(resolved: boolean, text: string, isError = false) {
  return {
    structuredContent: reviewApprovalOutputSchema.parse({ resolved }),
    content: [{ type: "text" as const, text }],
    ...(isError ? { isError: true as const } : {}),
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
