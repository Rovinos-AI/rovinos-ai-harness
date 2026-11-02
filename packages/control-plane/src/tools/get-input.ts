// SPDX-License-Identifier: Apache-2.0
import { Code } from "@rovinos/schemas";
import type { EventStore } from "@rovinos/store";
import type { McpServer } from "@modelcontextprotocol/server";
import { requireControlPlaneScope, withControlPlaneAuthorization } from "../auth.js";
import type { ControlPlaneAuditHandler } from "../auth.js";
import { getInputOutputSchema, getInputResultSchema, inputRequestInputSchema } from "../schemas.js";
import { findInputRequest, findPendingInput, getInputResult } from "./input-state.js";
import { INPUT_RESOURCE_URI } from "../resources/input.js";

/** Registers authorized retrieval of one tokenized input request. */
export function registerGetInputTool(
  server: McpServer,
  store: EventStore,
  now: () => number,
  onAudit?: ControlPlaneAuditHandler,
): void {
  server.registerTool(
    "get_input",
    {
      description: "Get one pending input's tokenized message and form or URL details.",
      inputSchema: inputRequestInputSchema,
      outputSchema: getInputResultSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      _meta: { ui: { resourceUri: INPUT_RESOURCE_URI } },
    },
    async (input, context) => {
      const parsed = inputRequestInputSchema.parse(input);
      const principal = requireControlPlaneScope(
        context,
        Code.parse("get_input"),
        "approve",
        onAudit,
      );
      const found = await findPendingInput(store, parsed.requestId, principal?.runIds);
      return withControlPlaneAuthorization({
        context,
        tool: Code.parse("get_input"),
        scope: "approve",
        ...(found === undefined ? {} : { runId: found.runId }),
        operation: async () => {
          if (found === undefined) {
            const existing = await findInputRequest(store, parsed.requestId, principal?.runIds);
            return inputError(
              existing === undefined ? "input_not_found" : "input_already_resolved",
            );
          }
          const result = getInputResult(found, now());
          return {
            structuredContent: getInputOutputSchema.parse(result),
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
          };
        },
        audit: onAudit,
      });
    },
  );
}

function inputError(code: "input_not_found" | "input_already_resolved") {
  const result = getInputResultSchema.parse({ code });
  return {
    structuredContent: result,
    content: [{ type: "text" as const, text: code }],
    isError: true as const,
  };
}
