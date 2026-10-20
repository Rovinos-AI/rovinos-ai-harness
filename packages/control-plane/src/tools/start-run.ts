// SPDX-License-Identifier: Apache-2.0
import { Code, Id, Principal, type RunStatus } from "@harness/schemas";
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import type { ControlPlaneAuditHandler } from "../auth.js";
import { controlPlanePrincipal, withControlPlaneAuthorization } from "../auth.js";
import type { ConfirmationClientCapabilities, ConfirmationGate } from "../confirmation-gate.js";
import {
  startRunInputSchema,
  startRunOutputSchema,
  type StartRunInput,
} from "../schemas.js";

const NEW_RUN_CONFIRMATION_TARGET = Id.parse("00000000000000000000000000");

/** Dependencies for the `start_run` tool. */
export interface StartRunToolOptions {
  readonly startRun?: (input: StartRunInput & { readonly requestedBy: Principal }) => Promise<{
    readonly runId: Id;
    readonly status: RunStatus;
  }>;
  readonly checkRunQuota?: (requestedBy: Principal, role: Code | undefined) => Promise<void>;
  readonly allowAgentStartedRuns: boolean;
  readonly confirmationGate: ConfirmationGate;
  readonly clientCapabilities: (
    context: ServerContext,
  ) => ConfirmationClientCapabilities | undefined;
  readonly onAudit?: ControlPlaneAuditHandler;
}

/** Registers the scoped and confirmation-gated `start_run` tool. */
export function registerStartRunTool(server: McpServer, options: StartRunToolOptions): void {
  server.registerTool(
    "start_run",
    {
      description: "Start a run and return its metadata.",
      inputSchema: startRunInputSchema,
      outputSchema: startRunOutputSchema,
      annotations: { openWorldHint: false },
    },
    async (input, context) => {
      const parsed = startRunInputSchema.safeParse(input);
      if (!parsed.success) {
        return runResult({ code: Code.parse("control_plane_input_invalid") });
      }
      return withControlPlaneAuthorization({
        context,
        tool: Code.parse("start_run"),
        scope: "run",
        operation: async () => {
          if (!options.allowAgentStartedRuns) {
            const gate = await options.confirmationGate.requireHuman(context, {
              toolName: "start_run",
              targetId: NEW_RUN_CONFIRMATION_TARGET,
              arguments: parsed.data,
              summary: "Start a new run?",
              clientCapabilities: options.clientCapabilities(context),
            });
            if (gate.status === "input_required") {
              return gate.result;
            }
            if (gate.status === "denied") {
              return runResult({ code: Code.parse(gate.code) });
            }
          }

          const requestedBy = runRequester(context);
          try {
            await options.checkRunQuota?.(requestedBy, parsed.data.role);
            if (options.startRun === undefined) {
              return runResult({ code: Code.parse("control_plane_runtime_unavailable") });
            }
            return runResult(
              await options.startRun({ ...parsed.data, requestedBy }),
            );
          } catch (error) {
            return runResult({ code: safeErrorCode(error, "start_run_failed") });
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
