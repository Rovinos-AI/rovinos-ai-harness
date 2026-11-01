// SPDX-License-Identifier: Apache-2.0
import {
  RunRecorder,
  type ApprovalDecision,
  type ApprovalResolutionMetadata,
  type Runtime,
  type HumanInputChannel,
} from "@rovinos/core";
import { Code, HarnessError, type Event, type Id, type JsonValue } from "@rovinos/schemas";
import type { ResolvedRun } from "../resolve.js";
import { ReplayDivergenceError, ReplayMissingResultError } from "./replay-model.js";
import {
  verifyInputRequest,
  matchesInput,
  type RecordedInputRequest,
  type RecordedInputResolution,
} from "./replay-inputs.js";

type ResolvedApproval = Extract<Event, { type: "approval_resolved" }>;

interface ReplayApprovalRuntime {
  resolveApproval(
    runId: Id,
    approvalId: Id,
    decision: ApprovalDecision,
    options?: { readonly edits?: JsonValue; readonly metadata?: ApprovalResolutionMetadata },
  ): Promise<unknown>;
  resume(runId: Id): Promise<unknown>;
}

interface ReplayInputRuntime extends Pick<Runtime, "store" | "clock"> {
  resolveInput(...args: Parameters<Runtime["resolveInput"]>): Promise<unknown>;
  resume(runId: Id): Promise<unknown>;
}

/** Replays recorded human decisions through core's durable resolve-and-resume paths. */
export class ReplayHuman {
  readonly alreadyTokenized = true;
  readonly legacyChannel: HumanInputChannel;
  private readonly approvals = new Map<Id, ResolvedApproval[]>();
  private readonly positions = new Map<Id, number>();
  private readonly inputs = new Map<Id, RecordedInputRequest>();
  private readonly inputResolutions = new Map<Id, RecordedInputResolution>();
  private readonly toolResults = new Map<Id, Extract<Event, { type: "tool_result" }>>();
  private legacyPosition = 0;

  /** Indexes input and approval pairs from the selected source run only. */
  constructor(resolved: ResolvedRun, sourceRunId = resolved.rootRunId) {
    this.legacyChannel = {
      id: Code.parse("replay.recorded"),
      available: (request) => request.source === "mcp_legacy",
      present: (request, signal) => {
        signal.throwIfAborted();
        const recorded = [...this.inputs.values()].filter(
          (input) => input.source === "mcp_legacy" && input.round === 0,
        )[this.legacyPosition];
        if (recorded === undefined) {
          return Promise.reject(new ReplayMissingResultError());
        }
        verifyInputRequest(request, recorded);
        const resolution = this.inputResolutions.get(recorded.requestId);
        if (resolution === undefined || resolution.decidedBy !== "human") {
          return Promise.reject(new ReplayMissingResultError(recorded.seq));
        }
        this.legacyPosition++;
        return Promise.resolve({
          action: resolution.action,
          ...(resolution.answer === undefined ? {} : { answer: resolution.answer }),
          principal: Code.parse(resolution.approverId ?? "cli.replay"),
        });
      },
    };
    const requests = new Map<Id, Extract<Event, { type: "approval_requested" }>>();
    const events = resolved.runs.find((run) => run.runId === sourceRunId)?.events ?? [];
    for (const event of events) {
      if (event.type === "approval_requested") {
        requests.set(event.approvalId, event);
      } else if (event.type === "approval_resolved") {
        const request = requests.get(event.approvalId);
        if (request !== undefined) {
          const items = this.approvals.get(request.callId) ?? [];
          items.push(event);
          this.approvals.set(request.callId, items);
        }
      } else if (event.type === "input_requested") {
        this.inputs.set(event.requestId, event);
      } else if (event.type === "input_resolved") {
        this.inputResolutions.set(event.requestId, event);
      } else if (event.type === "tool_result") {
        this.toolResults.set(event.callId, event);
      }
    }
  }

  /** Resolves every pending input in a round before resuming, without presenting a human UI. */
  async resolveInputsAndResume(
    runtime: ReplayInputRuntime,
    runId: Id,
    requests: readonly RecordedInputRequest[],
  ): Promise<void> {
    for (const request of requests) {
      const recordedRequest = [...this.inputs.values()].find((recorded) =>
        matchesInput(request, recorded),
      );
      const recorded =
        recordedRequest === undefined
          ? undefined
          : this.inputResolutions.get(recordedRequest.requestId);
      if (recordedRequest === undefined || recorded === undefined) {
        throw new ReplayMissingResultError(recordedRequest?.seq ?? request.seq);
      }
      verifyInputRequest(request, recordedRequest);
      if (
        recorded.source !== request.source ||
        recorded.round !== request.round ||
        recorded.mode !== request.mode ||
        recorded.decidedBy !== "human"
      ) {
        throw new ReplayDivergenceError(recorded.seq, "input_resolution_mismatch");
      }
      await runtime.resolveInput(runId, request.requestId, {
        action: recorded.action,
        ...(recorded.answer === undefined ? {} : { answer: recorded.answer }),
        principal: Code.parse(recorded.approverId ?? "cli.replay"),
      });
    }
    await this.recordAgentResults(runtime, runId, requests);
    await runtime.resume(runId);
  }

  // Core owns agent.ask_user and shadows external registries; serve its recorded result before
  // resuming rather than reconstructing a potentially different result with an empty replay vault.
  private async recordAgentResults(
    runtime: Pick<Runtime, "store" | "clock">,
    runId: Id,
    requests: readonly RecordedInputRequest[],
  ): Promise<void> {
    for (const request of requests.filter((input) => input.source === "agent")) {
      const result =
        request.callId === undefined ? undefined : this.toolResults.get(request.callId);
      if (result === undefined) {
        throw new ReplayMissingResultError(request.seq);
      }
      const events = [];
      for await (const event of runtime.store.read(runId)) {
        events.push(event);
      }
      const last = events.at(-1);
      if (last === undefined) {
        throw new ReplayMissingResultError(request.seq);
      }
      const recorder = new RunRecorder(
        runtime.store,
        runId,
        last.segmentId,
        last.seq + 1,
        runtime.clock,
      );
      await recorder.record({
        type: "tool_result",
        v: 1,
        callId: result.callId,
        toolId: result.toolId,
        outcome: result.outcome,
        latencyMs: result.latencyMs,
        result: result.result,
        ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
        ...(result.executedArgsHash === undefined
          ? {}
          : { executedArgsHash: result.executedArgsHash }),
      });
    }
  }

  /**
   * Applies a recorded approval, then resumes the suspended run through core.
   *
   * @param runtime - Isolated replay runtime.
   * @param runId - Replay run to resolve.
   * @param callId - Tool call whose recorded approval decision should be applied.
   * @returns The resumed run-loop outcome.
   */
  async resolveAndResume(runtime: ReplayApprovalRuntime, runId: Id, callId: Id): Promise<void> {
    const index = this.positions.get(callId) ?? 0;
    const recorded = this.approvals.get(callId)?.[index];
    if (recorded === undefined) {
      throw new ReplayApprovalMissingError();
    }
    this.positions.set(callId, index + 1);
    await runtime.resolveApproval(runId, recorded.approvalId, recorded.decision, {
      ...(recorded.edits === undefined ? {} : { edits: recorded.edits }),
      metadata: {
        decidedBy: recorded.decidedBy,
        ...(recorded.approverId === undefined ? {} : { approverId: recorded.approverId }),
        ...(recorded.reason === undefined ? {} : { reason: recorded.reason }),
      },
    });
    await runtime.resume(runId);
  }
}

/** Raised when an approval call has no recorded resolution. */
export class ReplayApprovalMissingError extends HarnessError {
  readonly code = "replay_missing_result";

  constructor() {
    super("A recorded approval resolution is unavailable.");
  }
}
