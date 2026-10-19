// SPDX-License-Identifier: Apache-2.0
import { Code, type Id } from "@harness/schemas";
import type { EventStore } from "@harness/store";
import type { McpServer } from "@modelcontextprotocol/server";
import type { ControlPlaneAuditHandler } from "../auth.js";
import { controlPlanePrincipal, withControlPlaneAuthorization } from "../auth.js";
import {
  listRunsInputSchema,
  listRunsOutputSchema,
  type ListRunsInput,
  type ListRunsOutput,
} from "../schemas.js";
import { readRunState } from "./run-state.js";

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
export async function listRuns(
  store: EventStore,
  input: ListRunsInput,
  runIds?: readonly Id[],
): Promise<ListRunsOutput> {
  const parsedInput = listRunsInputSchema.parse(input);
  if (runIds !== undefined) {
    return listAccessibleRuns(store, parsedInput, runIds);
  }
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
export function registerListRunsTool(
  server: McpServer,
  store: EventStore,
  audit?: ControlPlaneAuditHandler,
): void {
  server.registerTool(
    "list_runs",
    {
      description: "List run status and metadata counts.",
      inputSchema: listRunsInputSchema,
      outputSchema: listRunsOutputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (input, context) =>
      withControlPlaneAuthorization({
        context,
        tool: Code.parse("list_runs"),
        scope: "read",
        operation: async () => {
          const principal = controlPlanePrincipal(context);
          const output = await listRuns(store, input, principal?.runIds);
          return {
            structuredContent: output,
            content: [{ type: "text" as const, text: `${String(output.runs.length)} runs.` }],
          };
        },
        audit,
      }),
  );
}

async function listAccessibleRuns(
  store: EventStore,
  input: ReturnType<typeof listRunsInputSchema.parse>,
  allowedRunIds: readonly Id[],
): Promise<ListRunsOutput> {
  const summaries = await Promise.all(
    [...new Set(allowedRunIds)].map(async (runId) => {
      const run = await readRunState(store, runId);
      const first = run?.events[0];
      const last = run?.events.at(-1);
      if (run === undefined || first === undefined || last === undefined) {
        return undefined;
      }
      return {
        runId,
        status: run.state.status,
        createdAt: first.ts,
        lastTs: last.ts,
        lastSeq: last.seq,
        steps: run.state.steps,
        pendingApprovals: run.state.pendingApprovals.size,
      };
    }),
  );
  const matching = summaries
    .filter((summary) => summary !== undefined)
    .filter((summary) => input.status === undefined || summary.status === input.status)
    .sort(
      (left, right) => right.createdAt - left.createdAt || left.runId.localeCompare(right.runId),
    );
  const start = restrictedCursorIndex(input.cursor);
  const runs = matching.slice(start, start + input.limit);
  const nextIndex = start + runs.length;
  return listRunsOutputSchema.parse({
    runs,
    ...(nextIndex < matching.length ? { nextCursor: `restricted:${String(nextIndex)}` } : {}),
  });
}

function restrictedCursorIndex(cursor: string | undefined): number {
  if (cursor === undefined) {
    return 0;
  }
  const match = /^restricted:(\d+)$/.exec(cursor);
  if (match === null) {
    return 0;
  }
  const index = Number(match[1]);
  return Number.isSafeInteger(index) ? index : 0;
}
