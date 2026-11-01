// SPDX-License-Identifier: Apache-2.0
import { Code, type Id } from "@rovinos/schemas";
import type { EventStore } from "@rovinos/store";
import type { McpServer } from "@modelcontextprotocol/server";
import type { ControlPlaneAuditHandler } from "../auth.js";
import { controlPlanePrincipal, withControlPlaneAuthorization } from "../auth.js";
import { RUNS_CONSOLE_RESOURCE_URI } from "../resources/runs-console.js";
import {
  listRunsInputSchema,
  listRunsOutputSchema,
  type ListRunsInput,
  type ListRunsOutput,
} from "../schemas.js";

async function countRunMetadata(store: EventStore, runId: Id, lastSeq: number) {
  let steps = 0;
  const pendingApprovals = new Set<string>();
  const pendingInputs = new Set<string>();
  for await (const event of store.read(runId, { toSeq: lastSeq })) {
    if (event.type === "model_response") {
      steps += 1;
    } else if (event.type === "subagent_completed") {
      steps += event.steps ?? 0;
    } else if (event.type === "approval_requested") {
      pendingApprovals.add(event.approvalId);
    } else if (event.type === "approval_resolved") {
      pendingApprovals.delete(event.approvalId);
    } else if (event.type === "input_requested") {
      pendingInputs.add(event.requestId);
    } else if (event.type === "input_resolved") {
      pendingInputs.delete(event.requestId);
    }
  }
  return {
    steps,
    pendingApprovals: pendingApprovals.size,
    pendingInputs: pendingInputs.size,
  };
}

/** Lists run metadata and derived step, approval, and input counts. */
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
  options: { readonly name?: string; readonly appOnly?: boolean } = {},
): void {
  const name = options.name ?? "list_runs";
  const uiMeta =
    options.appOnly === true
      ? { ui: { visibility: ["app" as const], resourceUri: RUNS_CONSOLE_RESOURCE_URI } }
      : { ui: { resourceUri: RUNS_CONSOLE_RESOURCE_URI } };
  server.registerTool(
    name,
    {
      description: "List run status and metadata counts.",
      inputSchema: listRunsInputSchema,
      outputSchema: listRunsOutputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      _meta: uiMeta,
    },
    async (input, context) =>
      withControlPlaneAuthorization({
        context,
        tool: Code.parse(name),
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
  const cursor = restrictedStoreCursor(input.cursor);
  const page = await store.listRuns({
    limit: input.limit,
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(cursor === undefined ? {} : { cursor }),
  });
  const allowed = new Set(allowedRunIds);
  const summaries = page.runs.filter(({ runId }) => allowed.has(runId));
  const runs = await Promise.all(
    summaries.map(async (summary) => ({
      ...summary,
      ...(await countRunMetadata(store, summary.runId, summary.lastSeq)),
    })),
  );
  return listRunsOutputSchema.parse({
    runs,
    ...(page.nextCursor === undefined
      ? {}
      : { nextCursor: `restricted:${encodeURIComponent(page.nextCursor)}` }),
  });
}

function restrictedStoreCursor(cursor: string | undefined): string | undefined {
  if (cursor === undefined) {
    return undefined;
  }
  const match = /^restricted:(.+)$/.exec(cursor);
  const storeCursor = match?.[1];
  if (storeCursor === undefined || (/^\d+$/u.test(storeCursor) && storeCursor.length < 26)) {
    return undefined;
  }
  try {
    return decodeURIComponent(storeCursor);
  } catch {
    return undefined;
  }
}
