// SPDX-License-Identifier: Apache-2.0
import { JsonValue as JsonValueSchema, type Event } from "@harness/schemas";
import { buildApprovalPayload } from "@harness/policy";
import type { EventPartial } from "../recorder.js";
import { APPROVAL_WAIT_SPAN } from "../spans.js";
import type { ToolIntentEvent } from "../run-state.js";
import { ResumeEventMissingError } from "./resume-errors.js";
import type { ResumeToolStepOptions } from "./tool-step.js";

function callFromIntent(intent: ToolIntentEvent) {
  return { callId: intent.callId, toolId: intent.toolId, args: intent.args };
}

/** Records approvals for ambiguous dangling intents and suspends the parent run. */
export async function requestResumeApprovals(
  options: ResumeToolStepOptions,
  intents: readonly ToolIntentEvent[],
): Promise<readonly Event[]> {
  const events: Event[] = [];
  await options.recorder.withStepSpan(APPROVAL_WAIT_SPAN, {}, async () => {
    const now = Math.floor(options.clock.now());
    const batch: EventPartial[] = intents.map((intent) => {
      const payload = buildApprovalPayload({
        kind: "resume_ambiguity",
        call: callFromIntent(intent),
        rule: {
          id: intent.ruleId ?? "default",
          reason: intent.policyReason ?? "resume_ambiguous",
          ...(intent.policyApprovalTtlMs === undefined
            ? {}
            : { approvalTtlMs: intent.policyApprovalTtlMs }),
        },
        now,
      });
      return {
        type: "approval_requested",
        v: 1,
        approvalId: options.ids.next(),
        callId: intent.callId,
        payload: JsonValueSchema.parse(payload),
        ...(payload.expiresAt === undefined ? {} : { expiresAt: payload.expiresAt }),
      };
    });
    batch.push({
      type: "run_status_changed",
      v: 1,
      from: "running",
      to: "suspended",
      reason: "resume_ambiguity",
    });
    const recorded = await options.recorder.recordBatch(batch);
    events.push(...recorded);
    const last = recorded.at(-1);
    if (last === undefined) {
      throw new ResumeEventMissingError();
    }
    return last;
  });
  return events;
}
