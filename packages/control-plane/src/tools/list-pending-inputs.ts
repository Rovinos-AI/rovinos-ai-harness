// SPDX-License-Identifier: Apache-2.0
import { Code } from "@rovinos/schemas";
import type { EventStore } from "@rovinos/store";
import type { McpServer } from "@modelcontextprotocol/server";
import { requireControlPlaneScope, withControlPlaneAuthorization } from "../auth.js";
import type { ControlPlaneAuditHandler } from "../auth.js";
import {
  listPendingInputsInputSchema,
  listPendingInputsOutputSchema,
} from "../schemas.js";
import { listInputRequests } from "./input-state.js";

/** Registers metadata-only pending input listing with read scope and run filtering. */
export function registerListPendingInputsTool(
  server: McpServer,
  store: EventStore,
  now: () => number,
  onAudit?: ControlPlaneAuditHandler,
): void {
  server.registerTool(
    "list_pending_inputs",
    {
      description: "List pending human inputs using metadata only.",
      inputSchema: listPendingInputsInputSchema,
      outputSchema: listPendingInputsOutputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (input, context) => {
      const parsed = listPendingInputsInputSchema.parse(input);
      const principal = requireControlPlaneScope(
        context,
        Code.parse("list_pending_inputs"),
        "read",
        onAudit,
      );
      return withControlPlaneAuthorization({
        context,
        tool: Code.parse("list_pending_inputs"),
        scope: "read",
        ...(parsed.runId === undefined ? {} : { runId: parsed.runId }),
        operation: async () => {
          const allowedRunIds =
            parsed.runId === undefined
              ? principal?.runIds
              : principal?.runIds === undefined
                ? [parsed.runId]
                : principal.runIds.filter((runId) => runId === parsed.runId);
          const inputs = await listInputRequests(store, now(), allowedRunIds);
          const result = listPendingInputsOutputSchema.parse({ inputs });
          return {
            structuredContent: result,
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
          };
        },
        audit: onAudit,
      });
    },
  );
}
