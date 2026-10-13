// SPDX-License-Identifier: Apache-2.0
import type { Runtime } from "@harness/core";
import type { ApprovalSweepStore } from "@harness/policy";
import { ApprovalSweepResultSchema } from "@harness/schemas";
import type { CliContext } from "../command.js";

/** Runs the approval expiry and escalation sweep for the active CLI runtime. */
export async function runApprovalSweep(runtime: Runtime, context: CliContext): Promise<void> {
  const [{ LogNotifier, sweepApprovals }, { resolveApproval }] = await Promise.all([
    import("@harness/policy"),
    import("@harness/core"),
  ]);
  const store: ApprovalSweepStore = {
    listRuns: (options) => runtime.store.listRuns(options),
    read: (runId) => runtime.store.read(runId),
    claimApprovalNotification: (approvalId, runId, claimedAt, leaseMs) =>
      runtime.store.claimApprovalNotification(approvalId, runId, claimedAt, leaseMs),
    markApprovalNotificationSent: (approvalId, runId, claimedAt, sentAt) =>
      runtime.store.markApprovalNotificationSent(approvalId, runId, claimedAt, sentAt),
    releaseApprovalNotification: (approvalId, runId, claimedAt) =>
      runtime.store.releaseApprovalNotification(approvalId, runId, claimedAt),
    resolveApproval: (runId, approvalId, metadata) =>
      resolveApproval(
        runtime.store,
        runId,
        approvalId,
        "deny",
        undefined,
        context.clock,
        undefined,
        metadata,
      ),
  };
  const result = await sweepApprovals({
    store,
    clock: context.clock,
    notifier: new LogNotifier((notification) => {
      context.out.print(
        `approval_escalated run_id=${notification.runId} approval_id=${notification.approvalId} tool_id=${notification.toolId} rule_id=${notification.ruleId} age_ms=${String(notification.ageMs)}\n`,
      );
    }),
  });
  context.out.json(ApprovalSweepResultSchema, result);
  context.out.print(
    `examined=${String(result.examined)} expired=${String(result.expired)} escalated=${String(result.escalated)} failed=${String(result.failed)}\n`,
  );
}
