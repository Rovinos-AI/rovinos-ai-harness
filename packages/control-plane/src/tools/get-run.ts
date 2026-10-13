// SPDX-License-Identifier: Apache-2.0
import { Code } from "@harness/schemas";
import { toSafeEvent } from "@harness/telemetry";
import type { EventStore } from "@harness/store";
import type { McpServer } from "@modelcontextprotocol/server";
import { getRunInputSchema, getRunOutputSchema, type GetRunInput } from "../schemas.js";
import { readRunState } from "./run-state.js";

const SAFE_EVENT_POLICY_VERSION = Code.parse("control_plane_v1");

/** Returns one run's status, usage, pending approvals, and recent safe events. */
export async function getRun(store: EventStore, input: GetRunInput) {
  const { runId } = getRunInputSchema.parse(input);
  const run = await readRunState(store, runId);
  if (run === undefined) {
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
  const recentEvents = run.events.slice(-20).flatMap((event) => {
    const safeEvent = toSafeEvent(event, SAFE_EVENT_POLICY_VERSION);
    return safeEvent === null ? [] : [safeEvent];
  });
  return getRunOutputSchema.parse({
    runId,
    status: run.state.status,
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
  return `Run metadata: ${output.steps} steps, ${output.pendingApprovals.length} pending approvals, ${output.recentEvents.length} recent safe events.`;
}

/** Registers the `get_run` read-only MCP tool. */
export function registerGetRunTool(server: McpServer, store: EventStore): void {
  server.registerTool(
    "get_run",
    {
      description: "Get run status, usage, approvals, and recent safe event metadata.",
      inputSchema: getRunInputSchema,
      outputSchema: getRunOutputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      const output = await getRun(store, input);
      if (output === undefined) {
        return { isError: true, content: [{ type: "text", text: "run_not_found" }] };
      }
      return {
        structuredContent: output,
        content: [{ type: "text", text: getRunText(output) }],
      };
    },
  );
}
