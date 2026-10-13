// SPDX-License-Identifier: Apache-2.0
import type { Id } from "@harness/schemas";
import type { EventStore } from "@harness/store";
import type { McpServer } from "@modelcontextprotocol/server";
import { listRunsInputSchema, listRunsOutputSchema, type ListRunsInput } from "../schemas.js";

async function countRunMetadata(store: EventStore, runId: Id, lastSeq: number) {
  let steps = 0;
  const pendingApprovals = new Set<string>();
  for await (const event of store.read(runId, { toSeq: lastSeq })) {
    if (event.type === "model_response") {
      steps += 1;
    } else if (event.type === "approval_requested") {
      pendingApprovals.add(event.approvalId);
    } else if (event.type === "approval_resolved") {
      pendingApprovals.delete(event.approvalId);
    }
  }
  return { steps, pendingApprovals: pendingApprovals.size };
}

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
      const counts = await countRunMetadata(store, summary.runId, summary.lastSeq);
      return {
        ...summary,
        ...counts,
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
