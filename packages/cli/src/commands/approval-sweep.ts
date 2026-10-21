// SPDX-License-Identifier: Apache-2.0
import type { Runtime } from "@harness/core";
import type { ApprovalSweepStore } from "@harness/policy";
import { ApprovalSweepResultSchema, HarnessError } from "@harness/schemas";
import type { HarnessConfig } from "@harness/config";
import type { CliContext } from "../command.js";
import { createApprovalNotifier } from "./approval-notifier.js";

class ApprovalSweepPartialError extends HarnessError {
  override readonly code = "approval_sweep_partial";

  constructor() {
    super("Approval sweep partially failed.");
    this.name = "ApprovalSweepPartialError";
  }
}

/** Runs the approval expiry and escalation sweep for the active CLI runtime. */
export async function runApprovalSweep(
  runtime: Runtime,
  context: CliContext,
  config: HarnessConfig,
): Promise<void> {
  const { sweepApprovals } = await import("@harness/policy");
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
      runtime.resolveApproval(runId, approvalId, "deny", { metadata }),
  };
  const notifier = await createApprovalNotifier(
    config.policy.approvals,
    context.secretResolver,
    (notification) => {
      context.out.print(
        `approval_escalated run_id=${notification.runId} approval_id=${notification.approvalId} tool_id=${notification.toolId} rule_id=${notification.ruleId} age_ms=${String(notification.ageMs)}\n`,
      );
    },
  );
  const result = await sweepApprovals({
    store,
    clock: context.clock,
    notifier,
  });
  context.out.json(ApprovalSweepResultSchema, result);
  context.out.print(
    `examined=${String(result.examined)} expired=${String(result.expired)} escalated=${String(result.escalated)} failed=${String(result.failed)}\n`,
  );
  if (result.failed > 0) {
    throw new ApprovalSweepPartialError();
  }
}
