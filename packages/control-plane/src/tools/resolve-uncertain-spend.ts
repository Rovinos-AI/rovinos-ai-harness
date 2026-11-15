// SPDX-License-Identifier: Apache-2.0
import { Code, Principal, type Event, type Id, type NewEvent } from "@rovinos/schemas";
import {
  isSpendReservationStore,
  type EventStore,
} from "@rovinos/store";
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { controlPlanePrincipal, withControlPlaneAuthorization } from "../auth.js";
import type { ControlPlaneAuditHandler } from "../auth.js";
import type { ConfirmationClientCapabilities, ConfirmationGate } from "../confirmation-gate.js";
import { decisionOutputSchema, resolveUncertainSpendInputSchema } from "../schemas.js";

/** Dependencies for the `resolve_uncertain_spend` tool. */
export interface ResolveUncertainSpendToolOptions {
  readonly store: EventStore;
  readonly confirmationGate: ConfirmationGate;
  readonly clientCapabilities: (
    context: ServerContext,
  ) => ConfirmationClientCapabilities | undefined;
  readonly now: () => number;
  readonly onAudit?: ControlPlaneAuditHandler;
}

/** Registers an admin-only, human-confirmed waiver for uncertain spend. */
export function registerResolveUncertainSpendTool(
  server: McpServer,
  options: ResolveUncertainSpendToolOptions,
): void {
  server.registerTool(
    "resolve_uncertain_spend",
    {
      description:
        "Waive quota blocking for an uncertain spend attempt after human review; this does not establish whether the provider billed.",
      inputSchema: resolveUncertainSpendInputSchema,
      outputSchema: decisionOutputSchema,
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (input, context) => {
      const parsed = resolveUncertainSpendInputSchema.parse(input);
      return withControlPlaneAuthorization({
        context,
        tool: Code.parse("resolve_uncertain_spend"),
        scope: "admin",
        runId: parsed.runId,
        operation: async () => {
          const gate = await options.confirmationGate.requireHuman(context, {
            toolName: "resolve_uncertain_spend",
            targetId: parsed.attemptId,
            arguments: parsed,
            summary: `Waive quota blocking for spend attempt ${parsed.attemptId}? This does not establish provider billing.`,
            clientCapabilities: options.clientCapabilities(context),
          });
          if (gate.status === "input_required") {
            return gate.result;
          }
          if (gate.status === "denied") {
            return decisionResult(false, gate.code);
          }
          if (!isSpendReservationStore(options.store)) {
            return decisionResult(false, "spend_reservation_storage_unavailable");
          }

          try {
            const head = await options.store.head(parsed.runId);
            const lastEvent = await readLastEvent(options.store, parsed.runId, head);
            if (lastEvent === undefined) {
              return decisionResult(false, "run_not_found");
            }
            const principal = controlPlanePrincipal(context);
            const event: NewEvent = {
              runId: parsed.runId,
              ts: options.now(),
              v: 1,
              traceId: lastEvent.traceId,
              spanId: lastEvent.spanId,
              segmentId: lastEvent.segmentId,
              type: "spend_reservation_resolved",
              attemptId: parsed.attemptId,
              decision: "waive",
              decidedBy:
                principal === undefined
                  ? Principal.parse("cli.control_plane")
                  : Principal.parse(`token.${principal.tokenId}`),
              reason: parsed.reason,
            };
            await options.store.resolveUncertainSpend(event, head);
            return decisionResult(true);
          } catch (error) {
            return decisionResult(false, safeErrorCode(error));
          }
        },
        audit: options.onAudit,
      });
    },
  );
}

async function readLastEvent(
  store: EventStore,
  runId: Id,
  head: number,
): Promise<Event | undefined> {
  if (head < 1) {
    return undefined;
  }
  for await (const event of store.read(runId, { fromSeq: head - 1, toSeq: head - 1 })) {
    return event;
  }
  return undefined;
}

function decisionResult(ok: boolean, code?: string) {
  const output = decisionOutputSchema.parse({
    ok,
    ...(code === undefined ? {} : { code: Code.parse(code) }),
  });
  return {
    structuredContent: output,
    content: [
      {
        type: "text" as const,
        text: code ?? (ok ? "Operator resolution recorded." : "No change."),
      },
    ],
    ...(ok ? {} : { isError: true }),
  };
}

function safeErrorCode(error: unknown): Code {
  if (typeof error === "object" && error !== null && "code" in error) {
    const parsed = Code.safeParse(error.code);
    if (parsed.success) {
      return parsed.data;
    }
  }
  return Code.parse("spend_reservation_resolution_failed");
}
