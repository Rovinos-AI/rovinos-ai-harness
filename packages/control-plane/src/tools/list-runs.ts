// SPDX-License-Identifier: Apache-2.0
import type { EventStore } from "@harness/store";
import type { McpServer } from "@modelcontextprotocol/server";
import { listRunsInputSchema, listRunsOutputSchema, type ListRunsInput } from "../schemas.js";
import { readRunState } from "./run-state.js";

/** Lists run metadata and derived step and approval counts. */
export async function listRuns(store: EventStore, input: ListRunsInput) {
  const parsedInput = listRunsInputSchema.parse(input);
  const page = await store.listRuns({
    limit: parsedInput.limit,
    ...(parsedInput.status === undefined ? {} : { status: parsedInput.status }),
    ...(parsedInput.cursor === undefined ? {} : { cursor: parsedInput.cursor }),
  });
  const runs = await Promise.all(
    page.runs.map(async (summary) => {
      const run = await readRunState(store, summary.runId);
      return {
        ...summary,
        steps: run?.state.steps ?? 0,
        pendingApprovals: run?.state.pendingApprovals.size ?? 0,
      };
    }),
  );
  return listRunsOutputSchema.parse({
    runs,
    ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
  });
}

/** Registers the `list_runs` read-only MCP tool. */
export function registerListRunsTool(server: McpServer, store: EventStore): void {
  server.registerTool(
    "list_runs",
    {
      description: "List run status and metadata counts.",
      inputSchema: listRunsInputSchema,
      outputSchema: listRunsOutputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      const output = await listRuns(store, input);
      return {
        structuredContent: output,
        content: [{ type: "text", text: `${output.runs.length} runs.` }],
      };
    },
  );
}
