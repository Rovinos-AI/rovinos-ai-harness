// SPDX-License-Identifier: Apache-2.0
import {
  HarnessError,
  Id,
  InspectResultSchema,
  JsonValue,
  type Event,
  type InspectEvent,
  type InspectResult,
} from "@harness/schemas";
import type { CommandModule } from "../command.js";
import { createCommandRuntime } from "../command.js";

class RunNotFoundError extends HarnessError {
  override readonly code = "run_not_found";

  constructor() {
    super("Run was not found.");
  }
}

async function readEvents(
  store: { read(runId: Event["runId"]): AsyncIterable<Event> },
  runId: Event["runId"],
): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of store.read(runId)) {
    events.push(event);
  }
  return events;
}

/** Registers the `harness inspect` command. */
export const inspectCommand: CommandModule = {
  name: "inspect",
  /** Registers the `inspect` command. */
  register(program, context) {
    program
      .command("inspect")
      .description("Show run status and a safe summary of its recent events")
      .argument("<runId>", "run identifier")
      .option("--show-content", "include stored event content verbatim")
      .action(async (value: string, options: { readonly showContent?: boolean }) => {
        const runId = Id.parse(value);
        const config = await context.loadConfig();
        const runtime = await createCommandRuntime(context, config, { readOnlyStore: true });
        try {
          const events = await readEvents(runtime.store, runId);
          if (events.length === 0) {
            throw new RunNotFoundError();
          }
          const { foldRunState } = await import("@harness/core");
          const state = foldRunState(events);
          const continuations: Id[] = [];
          let cursor: string | undefined;
          do {
            const page = await runtime.store.listRuns({
              continuationOf: runId,
              limit: 100,
              ...(cursor === undefined ? {} : { cursor }),
            });
            continuations.push(...page.runs.map(({ runId: continuationId }) => continuationId));
            cursor = page.nextCursor;
          } while (cursor !== undefined);
          const eventSummaries: InspectEvent[] = events.slice(-10).map((event) => ({
            type: event.type,
            seq: event.seq,
            ...(options.showContent === true ? { event: JsonValue.parse(event) } : {}),
          }));
          const result: InspectResult = {
            runId,
            status: state.status,
            steps: state.steps,
            usage: state.usage,
            lastCheckpoint: state.lastCheckpoint ?? null,
            pendingApprovals: Array.from(state.pendingApprovals.values(), (approval) => ({
              approvalId: approval.approvalId,
              toolId: state.pendingToolCalls.get(approval.callId)?.toolId ?? "unknown",
            })),
            continuations,
            events: eventSummaries,
          };
          const parsed = InspectResultSchema.parse(result);
          if (options.showContent === true) {
            context.out.error("content_may_be_sensitive");
          }
          context.out.json(InspectResultSchema, parsed);
          context.out.print(`${JSON.stringify(parsed, null, 2)}\n`);
        } finally {
          await runtime.close();
        }
      });
  },
};
