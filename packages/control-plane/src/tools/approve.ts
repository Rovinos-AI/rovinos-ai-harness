// SPDX-License-Identifier: Apache-2.0
import { Code, type Id, type JsonValue } from "@harness/schemas";
import type { EventStore } from "@harness/store";
import type { ClientCapabilities, McpServer } from "@modelcontextprotocol/server";
import { ConfirmationGate } from "../confirmation-gate.js";
import { approveInputSchema, decisionOutputSchema } from "../schemas.js";
import type { ApprovalDecision } from "@harness/core";
import { findApprovalRequest } from "./run-state.js";

/** Executes one validated approval resolution. */
export type ResolveApprovalOperation = (
  runId: Id,
  approvalId: Id,
  decision: ApprovalDecision,
  edits?: JsonValue,
  reason?: Code,
) => Promise<unknown>;

/** Dependencies for the `approve` tool. */
export interface ApproveToolOptions {
  readonly store: EventStore;
  readonly confirmationGate: ConfirmationGate;
  readonly resolveApproval?: ResolveApprovalOperation;
  readonly clientCapabilities: () => ClientCapabilities | undefined;
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
      const gate = await options.confirmationGate.requireHuman(context, {
        toolName: "approve",
        targetId: parsed.approvalId,
        arguments: parsed,
        summary: `Approve request ${parsed.approvalId}?`,
        clientCapabilities: options.clientCapabilities(),
      });
      if (gate.status === "input_required") {
        return gate.result;
      }
      if (gate.status === "denied") {
        return decisionResult(false, gate.code);
      }

      const approval = await findApprovalRequest(options.store, parsed.approvalId);
      if (approval === undefined) {
        return decisionResult(false, "approval_not_found");
      }
      if (approval.resolved) {
        return decisionResult(false, "approval_already_resolved");
      }
      if (options.resolveApproval === undefined) {
        return decisionResult(false, "control_plane_runtime_unavailable");
      }

      try {
        await options.resolveApproval(
          approval.runId,
          parsed.approvalId,
          parsed.edits === undefined ? "approve" : "edit",
          parsed.edits,
        );
        return decisionResult(true);
      } catch (error) {
        return decisionResult(false, safeErrorCode(error));
      }
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
