// SPDX-License-Identifier: Apache-2.0
import { Code, Id, Principal, type RunStatus } from "@harness/schemas";
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import type { ControlPlaneAuditHandler } from "../auth.js";
import { controlPlanePrincipal, withControlPlaneAuthorization } from "../auth.js";
import type { ConfirmationClientCapabilities, ConfirmationGate } from "../confirmation-gate.js";
import {
  continueRunInputSchema,
  startRunOutputSchema,
  type ContinueRunInput,
} from "../schemas.js";

/** Dependencies for the `continue_run` tool. */
export interface ContinueRunToolOptions {
  readonly continueRun?: (
    runId: Id,
    input: Omit<ContinueRunInput, "runId"> & { readonly requestedBy: Principal },
  ) => Promise<{ readonly runId: Id; readonly status: RunStatus }>;
  readonly checkRunQuota?: (requestedBy: Principal) => Promise<void>;
  readonly confirmationGate: ConfirmationGate;
  readonly clientCapabilities: (
    context: ServerContext,
  ) => ConfirmationClientCapabilities | undefined;
  readonly onAudit?: ControlPlaneAuditHandler;
}

/** Registers the scoped and confirmation-gated `continue_run` tool. */
export function registerContinueRunTool(
  server: McpServer,
  options: ContinueRunToolOptions,
): void {
  server.registerTool(
    "continue_run",
    {
      description: "Start a follow-up run from a completed run.",
      inputSchema: continueRunInputSchema,
      outputSchema: startRunOutputSchema,
      annotations: { openWorldHint: false },
    },
    async (input, context) => {
      const parsed = continueRunInputSchema.safeParse(input);
      if (!parsed.success) {
        return runResult({ code: Code.parse("control_plane_input_invalid") });
      }
      return withControlPlaneAuthorization({
        context,
        tool: Code.parse("continue_run"),
        scope: "run",
        runId: parsed.data.runId,
        operation: async () => {
          const gate = await options.confirmationGate.requireHuman(context, {
            toolName: "continue_run",
            targetId: parsed.data.runId,
            arguments: parsed.data,
            summary: `Continue run ${parsed.data.runId}?`,
            clientCapabilities: options.clientCapabilities(context),
          });
          if (gate.status === "input_required") {
            return gate.result;
          }
          if (gate.status === "denied") {
            return runResult({ code: Code.parse(gate.code) });
          }

          const requestedBy = runRequester(context);
          try {
            await options.checkRunQuota?.(requestedBy);
            if (options.continueRun === undefined) {
              return runResult({ code: Code.parse("control_plane_runtime_unavailable") });
            }
            return runResult(
              await options.continueRun(parsed.data.runId, {
                goal: parsed.data.goal,
                ...(parsed.data.metadata === undefined
                  ? {}
                  : { metadata: parsed.data.metadata }),
                requestedBy,
              }),
            );
          } catch (error) {
            return runResult({ code: safeErrorCode(error, "continue_run_failed") });
          }
        },
        audit: options.onAudit,
      });
    },
  );
}

function runRequester(context: ServerContext): Principal {
  const principal = controlPlanePrincipal(context);
  return Principal.parse(`token.${principal?.tokenId ?? "local"}`);
}

function runResult(result: { readonly runId: Id; readonly status: RunStatus } | { readonly code: Code }) {
  const output = startRunOutputSchema.parse(result);
  if ("code" in output) {
    return {
      structuredContent: output,
      content: [{ type: "text" as const, text: output.code }],
      isError: true,
    };
  }
  return {
    structuredContent: output,
    content: [{ type: "text" as const, text: `${output.status} ${output.runId}` }],
  };
}

function safeErrorCode(error: unknown, fallback: string): Code {
  if (typeof error === "object" && error !== null && "code" in error) {
    const parsed = Code.safeParse(error.code);
    if (parsed.success) {
      return parsed.data;
    }
  }
  return Code.parse(fallback);
}
