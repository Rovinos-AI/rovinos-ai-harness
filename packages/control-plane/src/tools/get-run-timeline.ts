// SPDX-License-Identifier: Apache-2.0
import { Code } from "@rovinos/schemas";
import type { EventStore } from "@rovinos/store";
import type { McpServer } from "@modelcontextprotocol/server";
import type { ControlPlaneAuditHandler } from "../auth.js";
import { withControlPlaneAuthorization } from "../auth.js";
import { getRunTimelineInputSchema, getRunTimelineOutputSchema } from "../schemas.js";
import { getRunTimeline } from "./run-timeline.js";

/** Registers the metadata-only `get_run_timeline` read tool. */
export function registerGetRunTimelineTool(
  server: McpServer,
  store: EventStore,
  audit?: ControlPlaneAuditHandler,
): void {
  server.registerTool(
    "get_run_timeline",
    {
      description: "Get run events grouped into safe timeline steps and usage metadata.",
      inputSchema: getRunTimelineInputSchema,
      outputSchema: getRunTimelineOutputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (input, context) => {
      const parsed = getRunTimelineInputSchema.parse(input);
      return withControlPlaneAuthorization({
        context,
        tool: Code.parse("get_run_timeline"),
        scope: "read",
        runId: parsed.runId,
        operation: async () => {
          const output = await getRunTimeline(store, {
            runId: parsed.runId,
            ...(parsed.sinceSeq === undefined ? {} : { sinceSeq: parsed.sinceSeq }),
          });
          if (output === undefined) {
            return { isError: true, content: [{ type: "text" as const, text: "run_not_found" }] };
          }
          return {
            structuredContent: output,
            content: [
              {
                type: "text" as const,
                text: `${String(output.steps.length)} timeline steps.`,
              },
            ],
          };
        },
        audit,
      });
    },
  );
}
