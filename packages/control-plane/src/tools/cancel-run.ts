// SPDX-License-Identifier: Apache-2.0
import { Code, type Id } from "@harness/schemas";
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import type { ControlPlaneAuditHandler } from "../auth.js";
import { withControlPlaneAuthorization } from "../auth.js";
import type { ConfirmationClientCapabilities, ConfirmationGate } from "../confirmation-gate.js";
import { decisionOutputSchema, runLifecycleInputSchema } from "../schemas.js";
import type { RunSupervisor } from "../run-supervisor.js";

/** Dependencies for the `cancel_run` tool. */
export interface CancelRunToolOptions {
  readonly confirmationGate: ConfirmationGate;
  readonly supervisor: RunSupervisor;
  readonly cancelRun?: (runId: Id) => Promise<unknown>;
  readonly clientCapabilities: (
    context: ServerContext,
  ) => ConfirmationClientCapabilities | undefined;
  readonly onAudit?: ControlPlaneAuditHandler;
}

/** Registers the confirmation-gated `cancel_run` tool. */
export function registerCancelRunTool(server: McpServer, options: CancelRunToolOptions): void {
  server.registerTool(
    "cancel_run",
    {
      description: "Request cancellation of a run.",
      inputSchema: runLifecycleInputSchema,
      outputSchema: decisionOutputSchema,
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (input, context) => {
      const parsed = runLifecycleInputSchema.parse(input);
      return withControlPlaneAuthorization({
        context,
        tool: Code.parse("cancel_run"),
        scope: "run",
        runId: parsed.runId,
        operation: async () => {
          const gate = await options.confirmationGate.requireHuman(context, {
            toolName: "cancel_run",
            targetId: parsed.runId,
            arguments: parsed,
            summary: `Cancel run ${parsed.runId}?`,
            clientCapabilities: options.clientCapabilities(context),
          });
          if (gate.status === "input_required") {
            return gate.result;
          }
          if (gate.status === "denied") {
            return decisionResult(false, gate.code);
          }
          if (options.cancelRun === undefined) {
            return decisionResult(false, "control_plane_runtime_unavailable");
          }

          options.supervisor.abort(parsed.runId);
          try {
            const result = await options.cancelRun(parsed.runId);
            if (result === "already_terminal") {
              return decisionResult(true, "already_terminal");
            }
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
    content: [
      { type: "text" as const, text: code ?? (ok ? "Cancellation requested." : "No change.") },
    ],
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
  return Code.parse("cancel_failed");
}
