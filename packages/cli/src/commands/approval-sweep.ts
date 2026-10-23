// SPDX-License-Identifier: Apache-2.0
import {
  expireInput,
  foldRunState,
  InputAlreadyResolvedError,
  InputNotExpiredError,
  InputNotFoundError,
  InputRunTerminalError,
  type Clock,
  type Runtime,
} from "@harness/core";
import type { ApprovalSweepStore } from "@harness/policy";
import { ApprovalSweepResultSchema, HarnessError } from "@harness/schemas";
import type { Event, Id } from "@harness/schemas";
import type { HarnessConfig } from "@harness/config";
import type { EventStore, RunQueue } from "@harness/store";
import type { CliContext } from "../command.js";
import { createApprovalNotifier } from "./approval-notifier.js";

/** Counts of pending inputs examined, expired, and failed by the CLI sweep. */
export interface InputSweepResult {
  readonly examined: number;
  readonly expired: number;
  readonly failed: number;
}

interface InputSweepOptions {
  readonly store: EventStore;
  readonly queue?: Pick<RunQueue, "enqueue">;
  readonly clock: Clock;
  readonly expiresAfterMs: number;
}

/** Expires one pending input and classifies concurrent resolution as skipped. */
async function expirePendingInput(
  options: InputSweepOptions,
  runId: Id,
  requestId: Id,
): Promise<"expired" | "failed" | "skipped"> {
  try {
    await expireInput(options.store, runId, requestId, {
      expiresAfterMs: options.expiresAfterMs,
      clock: options.clock,
      ...(options.queue === undefined ? {} : { queue: options.queue }),
    });
    return "expired";
  } catch (error) {
    return error instanceof InputAlreadyResolvedError ||
      error instanceof InputNotExpiredError ||
      error instanceof InputNotFoundError ||
      error instanceof InputRunTerminalError
      ? "skipped"
      : "failed";
  }
}

/** Reads and folds the event history for a run's pending inputs. */
async function pendingInputsForRun(
  store: EventStore,
  runId: Id,
): Promise<ReturnType<typeof foldRunState>["pendingInputs"]> {
  const events: Event[] = [];
  for await (const event of store.read(runId)) {
    events.push(event);
  }
  return foldRunState(events).pendingInputs;
}

/** Expires durable pending inputs using the shared event store and queue. */
export async function sweepPendingInputs(options: InputSweepOptions): Promise<InputSweepResult> {
  const result = { examined: 0, expired: 0, failed: 0 };
  let cursor: string | undefined;
  do {
    const page = await options.store.listRuns({
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    });
    cursor = page.nextCursor;
    for (const { runId } of page.runs) {
      const requests = await pendingInputsForRun(options.store, runId);
      for (const request of requests.values()) {
        result.examined += 1;
        const outcome = await expirePendingInput(options, runId, request.requestId);
        if (outcome === "expired") {
          result.expired += 1;
        } else if (outcome === "failed") {
          result.failed += 1;
        }
      }
    }
  } while (cursor !== undefined);
  return result;
}

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
  const inputResult = await sweepPendingInputs({
    store: runtime.store,
    ...(runtime.queue === undefined ? {} : { queue: runtime.queue }),
    clock: context.clock,
    expiresAfterMs: config.elicitation.expiresAfterMs,
  });
  context.out.json(ApprovalSweepResultSchema, result);
  context.out.print(
    `examined=${String(result.examined)} expired=${String(result.expired)} escalated=${String(result.escalated)} failed=${String(result.failed)}\n`,
  );
  context.out.print(
    `inputs_examined=${String(inputResult.examined)} inputs_expired=${String(inputResult.expired)} inputs_failed=${String(inputResult.failed)}\n`,
  );
  if (result.failed > 0 || inputResult.failed > 0) {
    throw new ApprovalSweepPartialError();
  }
}
