// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { Code, type Event, type Message } from "@rovinos/schemas";

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

/** State accumulated while reconstructing successful plan updates. */
export interface PlanReducerState {
  readonly pendingUpdates: ReadonlyMap<string, Extract<Event, { type: "tool_intent" }>>;
  readonly plan?: Plan;
}

/** Creates a fresh empty plan-reducer state. */
export function createPlanReducerState(): PlanReducerState {
  return { pendingUpdates: new Map() };
}

/**
 * Applies one event to the state derived from plan tool events.
 *
 * @param state - State derived from earlier events.
 * @param event - The next event in log order.
 * @returns The updated plan-reducer state.
 */
export function planReducer(state: PlanReducerState, event: Event): PlanReducerState {
  if (event.type === "tool_intent" && event.toolId === "update_plan") {
    const pendingUpdates = new Map(state.pendingUpdates);
    pendingUpdates.set(event.callId, event);
    return { ...state, pendingUpdates };
  }
  if (event.type !== "tool_result") {
    return state;
  }

  const intent = state.pendingUpdates.get(event.callId);
  if (event.toolId !== intent?.toolId) {
    return state;
  }

  const pendingUpdates = new Map(state.pendingUpdates);
  pendingUpdates.delete(event.callId);
  if (event.outcome !== "ok") {
    return { ...state, pendingUpdates };
  }

  const input = UpdatePlanInputSchema.safeParse(intent.args);
  return input.success ? { pendingUpdates, plan: input.data.plan } : { ...state, pendingUpdates };
}

/**
 * Reconstructs the most recent successfully updated plan from tool events.
 *
 * @param events - Validated events from one run.
 * @returns The latest successful plan, or undefined when none was recorded.
 */
export function derivePlan(events: readonly Event[]): Plan | undefined {
  return [...events]
    .sort((left, right) => left.seq - right.seq)
    .reduce(planReducer, createPlanReducerState()).plan;
}

/** Renders a stable final context message for the current plan. */
export function renderPlanMessage(plan: Plan): Message {
  const validatedPlan = PlanSchema.parse(plan);
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
