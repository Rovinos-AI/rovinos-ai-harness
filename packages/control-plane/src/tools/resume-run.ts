// SPDX-License-Identifier: Apache-2.0
import { Code } from "@rovinos/schemas";
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import type { ControlPlaneAuditHandler } from "../auth.js";
import { withControlPlaneAuthorization } from "../auth.js";
import type { ConfirmationClientCapabilities, ConfirmationGate } from "../confirmation-gate.js";
import { resumeRunOutputSchema, runLifecycleInputSchema } from "../schemas.js";
import type { RunSupervisor } from "../run-supervisor.js";

/** Dependencies for the `resume_run` tool. */
export interface ResumeRunToolOptions {
  readonly confirmationGate: ConfirmationGate;
  readonly supervisor: RunSupervisor;
  readonly clientCapabilities: (
    context: ServerContext,
  ) => ConfirmationClientCapabilities | undefined;
  readonly onAudit?: ControlPlaneAuditHandler;
}

/** Registers the confirmation-gated `resume_run` tool. */
export function registerResumeRunTool(server: McpServer, options: ResumeRunToolOptions): void {
  server.registerTool(
    "resume_run",
    {
      description: "Resume a run asynchronously.",
      inputSchema: runLifecycleInputSchema,
      outputSchema: resumeRunOutputSchema,
      annotations: { openWorldHint: false },
    },
    async (input, context) => {
      const parsed = runLifecycleInputSchema.parse(input);
      return withControlPlaneAuthorization({
        context,
        tool: Code.parse("resume_run"),
        scope: "run",
        runId: parsed.runId,
        operation: async () => {
          const gate = await options.confirmationGate.requireHuman(context, {
            toolName: "resume_run",
            targetId: parsed.runId,
            arguments: parsed,
            summary: `Resume run ${parsed.runId}?`,
            clientCapabilities: options.clientCapabilities(context),
          });
          if (gate.status === "input_required") {
            return gate.result;
          }
          if (gate.status === "denied") {
            return resumeResult(false, gate.code);
          }
          const result = await options.supervisor.start(parsed.runId);
          return resumeResult(result.started, result.code);
        },
        audit: options.onAudit,
      });
    },
  );
}

function resumeResult(started: boolean, code?: string) {
  const output = resumeRunOutputSchema.parse({
    started,
    ...(code === undefined ? {} : { code: Code.parse(code) }),
  });
  return {
    structuredContent: output,
    content: [
      { type: "text" as const, text: code ?? (started ? "Resume started." : "No resume started.") },
    ],
    ...(started ? {} : { isError: true }),
  };
}
