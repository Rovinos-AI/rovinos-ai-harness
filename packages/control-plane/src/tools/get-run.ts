// SPDX-License-Identifier: Apache-2.0
import { Code } from "@harness/schemas";
import { POLICY_VERSION, toSafeEvent } from "@harness/telemetry";
import type { EventStore } from "@harness/store";
import type { McpServer } from "@modelcontextprotocol/server";
import type { ControlPlaneAuditHandler } from "../auth.js";
import { withControlPlaneAuthorization } from "../auth.js";
import { RUNS_CONSOLE_RESOURCE_URI } from "../resources/runs-console.js";
import {
  getRunInputSchema,
  getRunOutputSchema,
  type GetRunInput,
  type GetRunOutput,
} from "../schemas.js";
import { readRunState } from "./run-state.js";

/** Returns one run's status, usage, pending approvals, and recent safe events. */
export async function getRun(
  store: EventStore,
  input: GetRunInput,
): Promise<GetRunOutput | undefined> {
  const { runId, sinceSeq } = getRunInputSchema.parse(input);
  const run = await readRunState(store, runId);
  if (run === undefined) {
    return undefined;
  }
  const firstEvent = run.events[0];
  const lastEvent = run.events.at(-1);
  if (firstEvent?.type !== "run_created" || lastEvent === undefined) {
    return undefined;
  }
  const pendingApprovals = Array.from(run.state.pendingApprovals.values(), (approval) => {
    const intent = run.state.pendingToolCalls.get(approval.callId);
    return {
      approvalId: approval.approvalId,
      toolId: intent?.toolId ?? Code.parse("unknown"),
      ruleId: intent?.ruleId ?? Code.parse("unknown"),
      ...(approval.expiresAt === undefined ? {} : { expiresAt: approval.expiresAt }),
    };
  });
  const events = sinceSeq === undefined ? run.events.slice(-20) : run.events;
  const recentEvents = events.flatMap((event) => {
    if (sinceSeq !== undefined && event.seq <= sinceSeq) {
      return [];
    }
    const safeEvent = toSafeEvent(event, POLICY_VERSION);
    return safeEvent === null ? [] : [safeEvent];
  });
  return getRunOutputSchema.parse({
    runId,
    createdAt: firstEvent.ts,
    status: run.state.status,
    lastSeq: lastEvent.seq,
    lastTs: lastEvent.ts,
    steps: run.state.steps,
    usage: run.state.usage,
    ...(run.state.lastCheckpoint === undefined ? {} : { lastCheckpoint: run.state.lastCheckpoint }),
    pendingApprovals,
    recentEvents,
  });
}

/** Renders only metadata counts for clients that ignore structured tool output. */
export function getRunText(output: Awaited<ReturnType<typeof getRun>>): string {
  if (output === undefined) {
    return "run_not_found";
  }
  return `Run metadata: ${String(output.steps)} steps, ${String(output.pendingApprovals.length)} pending approvals, ${String(output.recentEvents.length)} recent safe events.`;
}

/** Registers the `get_run` read-only MCP tool. */
export function registerGetRunTool(
  server: McpServer,
  store: EventStore,
  audit?: ControlPlaneAuditHandler,
  options: { readonly name?: string; readonly appOnly?: boolean } = {},
): void {
  const name = options.name ?? "get_run";
  server.registerTool(
    name,
    {
      description: "Get run status, usage, approvals, and recent safe event metadata.",
      inputSchema: getRunInputSchema,
      outputSchema: getRunOutputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      ...(options.appOnly === true
        ? {
            _meta: {
              ui: { visibility: ["app" as const], resourceUri: RUNS_CONSOLE_RESOURCE_URI },
            },
          }
        : {}),
    },
    async (input, context) => {
      const parsed = getRunInputSchema.parse(input);
      return withControlPlaneAuthorization({
        context,
        tool: Code.parse(name),
        scope: "read",
        runId: parsed.runId,
        operation: async () => {
          const output = await getRun(store, parsed);
          if (output === undefined) {
            return { isError: true, content: [{ type: "text" as const, text: "run_not_found" }] };
          }
          return {
            structuredContent: output,
            content: [{ type: "text" as const, text: getRunText(output) }],
          };
        },
        audit,
      });
    },
  );
}
