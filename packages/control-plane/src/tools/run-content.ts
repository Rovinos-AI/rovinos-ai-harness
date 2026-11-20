// SPDX-License-Identifier: Apache-2.0
import { Code, JsonValue, parseJson } from "@rovinos/schemas";
import type { Event, Id } from "@rovinos/schemas";
import type { EventStore } from "@rovinos/store";
import type { McpServer } from "@modelcontextprotocol/server";
import type { ControlPlaneAuditHandler } from "../auth.js";
import {
  ControlPlaneAuthError,
  controlPlanePrincipal,
  withControlPlaneAuthorization,
} from "../auth.js";
import {
  getRunContentInputSchema,
  getRunContentOutputSchema,
  type GetRunContentOutput,
} from "../schemas.js";
import { readRunState } from "./run-state.js";

const TOOL_NAME = "harness.runs.content";
const MAX_CONTENT_EVENTS = 100;
type ContentEvent = GetRunContentOutput["events"][number];

function toJsonValue(value: unknown): JsonValue {
  return parseJson(JsonValue, JSON.stringify(value));
}

function contentEvent(event: Event): ContentEvent | undefined {
  switch (event.type) {
    case "run_input":
      return { seq: event.seq, type: event.type, value: toJsonValue(event.input) };
    case "model_request":
      return { seq: event.seq, type: event.type, value: toJsonValue(event.messages) };
    case "model_response":
      return {
        seq: event.seq,
        type: event.type,
        value: toJsonValue({
          content: event.content,
          ...(event.structuredValue === undefined
            ? {}
            : { structuredValue: event.structuredValue }),
        }),
      };
    case "tool_intent":
      return { seq: event.seq, type: event.type, value: toJsonValue(event.args) };
    case "tool_result":
      return { seq: event.seq, type: event.type, value: toJsonValue(event.result) };
    case "approval_requested":
      return { seq: event.seq, type: event.type, value: toJsonValue(event.payload) };
    case "input_requested":
      return {
        seq: event.seq,
        type: event.type,
        value: toJsonValue({
          message: event.message,
          ...(event.schema === undefined ? {} : { schema: event.schema }),
          ...(event.url === undefined ? {} : { url: event.url }),
        }),
      };
    case "input_resolved":
      return event.answer === undefined
        ? undefined
        : { seq: event.seq, type: event.type, value: toJsonValue(event.answer) };
    case "app_content":
    case "approval_resolved":
    case "budget_exceeded":
    case "checkpoint_written":
    case "context_compacted":
    case "pii_action":
    case "run_created":
    case "run_status_changed":
    case "spend_reservation_resolved":
    case "subagent_completed":
    case "subagent_spawned":
    case "tool_execution_started":
      return undefined;
  }
}

/** Returns the most recent content fields from the tokenized event log. */
export async function getRunContent(
  store: EventStore,
  input: { readonly runId: Id; readonly sinceSeq?: number },
): Promise<GetRunContentOutput | undefined> {
  const parsed = getRunContentInputSchema.parse(input);
  const run = await readRunState(store, parsed.runId);
  if (run === undefined) {
    return undefined;
  }
  const events = run.events.flatMap((event) => {
    if (parsed.sinceSeq !== undefined && event.seq <= parsed.sinceSeq) {
      return [];
    }
    const entry = contentEvent(event);
    return entry === undefined ? [] : [entry];
  });
  const truncated = events.length > MAX_CONTENT_EVENTS;
  return getRunContentOutputSchema.parse({
    runId: parsed.runId,
    truncated,
    events: events.slice(-MAX_CONTENT_EVENTS),
  });
}

/** Registers the app-only, `read_content`-scoped tokenized content tool. */
export function registerRunContentTool(
  server: McpServer,
  store: EventStore,
  audit?: ControlPlaneAuditHandler,
): void {
  server.registerTool(
    TOOL_NAME,
    {
      description: "Load recent tokenized run content after an explicit inspector action.",
      inputSchema: getRunContentInputSchema,
      outputSchema: getRunContentOutputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      _meta: { ui: { visibility: ["app"] } },
    },
    async (input, context) => {
      if (controlPlanePrincipal(context) === undefined) {
        throw new ControlPlaneAuthError("control_plane_scope_required");
      }
      const parsed = getRunContentInputSchema.parse(input);
      return withControlPlaneAuthorization({
        context,
        tool: Code.parse(TOOL_NAME),
        scope: "read_content",
        runId: parsed.runId,
        operation: async () => {
          const output = await getRunContent(store, {
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
                text: `${String(output.events.length)} tokenized content entries.`,
              },
            ],
          };
        },
        audit,
      });
    },
  );
}
