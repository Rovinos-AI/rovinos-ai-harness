// SPDX-License-Identifier: Apache-2.0
import { Code, Id, JsonValue, safeParseJson, type Event } from "@harness/schemas";
import { z } from "zod";

const SubagentUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    costMicros: z.number().int().nonnegative().optional(),
  })
  .strict();

/** Validated result returned by one child run to its parent. */
export const SubagentResultSchema = z
  .object({
    childRunId: Id,
    status: z.enum(["completed", "failed", "cancelled", "suspended"]),
    value: JsonValue.optional(),
    errorCode: Code.optional(),
    usage: SubagentUsageSchema,
  })
  .strict();

/** Inferred result returned by one child run to its parent. */
export type SubagentResult = z.infer<typeof SubagentResultSchema>;

function aggregateUsage(events: readonly Event[]) {
  let inputTokens = 0;
  let outputTokens = 0;
  let costMicros = 0;
  let hasCost = false;
  for (const event of events) {
    if (event.type !== "model_response") {
      continue;
    }
    inputTokens += event.inputTokens;
    outputTokens += event.outputTokens;
    if (event.costMicros !== undefined) {
      costMicros += event.costMicros;
      hasCost = true;
    }
  }
  return {
    inputTokens,
    outputTokens,
    ...(hasCost ? { costMicros } : {}),
  };
}

function failureCode(events: readonly Event[]): string | undefined {
  const terminal = events.findLast(
    (event) => event.type === "run_status_changed" && event.to !== "running",
  );
  if (terminal?.type !== "run_status_changed" || terminal.to === "suspended") {
    return undefined;
  }
  return terminal.reason === "result_invalid"
    ? Code.parse("subagent_result_invalid")
    : terminal.reason;
}

function finalText(events: readonly Event[]): string {
  const response = events.findLast((event) => event.type === "model_response");
  return response?.type === "model_response"
    ? response.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
    : "";
}

function invalidResult(childRunId: Id, usage: ReturnType<typeof aggregateUsage>): SubagentResult {
  return SubagentResultSchema.parse({
    childRunId,
    status: "failed",
    errorCode: "subagent_result_invalid",
    usage,
  });
}

function finalizeNonCompleted(options: {
  readonly childRunId: Id;
  readonly status: Exclude<SubagentResult["status"], "completed">;
  readonly events: readonly Event[];
  readonly usage: ReturnType<typeof aggregateUsage>;
}): SubagentResult {
  const errorCode = failureCode(options.events);
  return SubagentResultSchema.parse({
    childRunId: options.childRunId,
    status: options.status,
    ...(errorCode === undefined ? {} : { errorCode }),
    usage: options.usage,
  });
}

function finalizeCompleted(options: {
  readonly childRunId: Id;
  readonly events: readonly Event[];
  readonly hasResultSchema: boolean;
  readonly usage: ReturnType<typeof aggregateUsage>;
}): SubagentResult {
  if (!options.hasResultSchema) {
    return SubagentResultSchema.parse({
      childRunId: options.childRunId,
      status: "completed",
      value: { text: finalText(options.events) },
      usage: options.usage,
    });
  }
  const response = options.events.findLast((event) => event.type === "model_response");
  if (
    response?.type !== "model_response" ||
    !response.schemaValid ||
    response.rungUsed === undefined
  ) {
    return invalidResult(options.childRunId, options.usage);
  }
  const parsed = safeParseJson(JsonValue, finalText(options.events));
  if (!parsed.success) {
    return invalidResult(options.childRunId, options.usage);
  }
  return SubagentResultSchema.parse({
    childRunId: options.childRunId,
    status: "completed",
    value: parsed.data,
    usage: options.usage,
  });
}

/** Finalizes a child's tokenized event history into its parent-facing result. */
export function finalizeChild(options: {
  readonly childRunId: Id;
  readonly status: SubagentResult["status"];
  readonly events: readonly Event[];
  readonly hasResultSchema: boolean;
}): SubagentResult {
  const usage = aggregateUsage(options.events);
  if (options.status !== "completed") {
    return finalizeNonCompleted({
      childRunId: options.childRunId,
      status: options.status,
      events: options.events,
      usage,
    });
  }
  return finalizeCompleted({
    childRunId: options.childRunId,
    events: options.events,
    hasResultSchema: options.hasResultSchema,
    usage,
  });
}
