// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { Code, type Event, type Message } from "@harness/schemas";

const PlanItemSchema = z
  .object({
    id: Code,
    text: z.string().max(500),
    status: z.enum(["todo", "doing", "done"]),
  })
  .strict();

/** Schema for the durable model plan and its notes. */
export const PlanSchema = z
  .object({
    items: z.array(PlanItemSchema).max(50),
    notes: z.string().max(4000),
  })
  .strict();

/** Inferred durable model plan. */
export type Plan = z.infer<typeof PlanSchema>;

/** Schema for the built-in `update_plan` tool input. */
export const UpdatePlanInputSchema = z.object({ plan: PlanSchema }).strict();

/**
 * Reconstructs the most recent successfully updated plan from tool events.
 *
 * @param events - Validated events from one run.
 * @returns The latest successful plan, or undefined when none was recorded.
 */
export function derivePlan(events: readonly Event[]): Plan | undefined {
  const pendingUpdates = new Map<string, Extract<Event, { type: "tool_intent" }>>();
  let plan: Plan | undefined;

  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    if (event.type === "tool_intent" && event.toolId === "update_plan") {
      pendingUpdates.set(event.callId, event);
    } else if (event.type === "tool_result") {
      const intent = pendingUpdates.get(event.callId);
      if (intent?.toolId !== event.toolId) {
        continue;
      }
      pendingUpdates.delete(event.callId);
      if (event.outcome !== "ok") {
        continue;
      }
      const input = UpdatePlanInputSchema.safeParse(intent.args);
      if (input.success) {
        plan = input.data.plan;
      }
    }
  }

  return plan;
}

/** Renders a stable final context message for the current plan. */
export function renderPlanMessage(plan: Plan | undefined): Message {
  const validatedPlan = PlanSchema.parse(plan ?? { items: [], notes: "" });
  return {
    role: "user",
    parts: [
      {
        type: "text",
        text: `Current plan: ${JSON.stringify({
          items: validatedPlan.items.map(({ id, text, status }) => ({ id, text, status })),
          notes: validatedPlan.notes,
        })}`,
      },
    ],
  };
}
