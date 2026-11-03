// SPDX-License-Identifier: Apache-2.0
import type { Event, Id } from "@rovinos/schemas";
import type { ModelToolCall, RunContext } from "@rovinos/core";
import {
  recordedInputResponses,
  sameRecordedJson,
  type RecordedInputRequest,
  type RecordedInputResolution,
} from "./replay-inputs.js";
import { ReplayDivergenceError } from "./replay-model.js";
import { ReplayLegacyInputs } from "./replay-legacy-inputs.js";

type InputRetry = RunContext["inputRetry"];
type InputRequired = Parameters<NonNullable<RunContext["elicitation"]>["handleInputRequired"]>[0];

function verifyRetry(
  requests: readonly RecordedInputRequest[],
  resolutions: ReadonlyMap<Id, RecordedInputResolution>,
  retry: InputRetry,
): void {
  const first = requests[0];
  if (first === undefined) {
    return;
  }
  if (
    retry?.round !== first.round ||
    !sameRecordedJson(retry.requestState, first.requestState) ||
    !sameRecordedJson(retry.inputResponses, recordedInputResponses(requests, resolutions)) ||
    (retry.source ?? "mcp_mrtr") !== first.source
  ) {
    throw new ReplayDivergenceError(first.seq, "input_round_mismatch");
  }
}

/** Deterministic MRTR request rounds; never communicates with an MCP server or human. */
export class ReplayInputRounds {
  private readonly legacy: ReplayLegacyInputs;
  private readonly rounds = new Map<Id, RecordedInputRequest[][]>();
  private readonly resolutions = new Map<Id, RecordedInputResolution>();
  private readonly positions = new Map<Id, number>();

  /** Indexes requests and resolutions from one source run. */
  constructor(events: readonly Event[]) {
    this.legacy = new ReplayLegacyInputs(events);
    for (const event of events) {
      if (event.type === "input_resolved") {
        this.resolutions.set(event.requestId, event);
      } else if (
        event.type === "input_requested" &&
        event.callId !== undefined &&
        !(event.source === "mcp_legacy" && event.round === 0)
      ) {
        const rounds = this.rounds.get(event.callId) ?? [];
        if (rounds.at(-1)?.[0]?.round === event.round) {
          rounds.at(-1)?.push(event);
        } else {
          rounds.push([event]);
        }
        this.rounds.set(event.callId, rounds);
      }
    }
  }

  private required(requests: readonly RecordedInputRequest[], context: RunContext): InputRequired {
    const first = requests[0];
    if (
      first?.serverId === undefined ||
      first.callId === undefined ||
      first.source === "agent" ||
      (first.requestState !== undefined && typeof first.requestState !== "string")
    ) {
      throw new ReplayDivergenceError(first?.seq ?? 0, "input_round_mismatch");
    }
    return {
      callId: first.callId,
      serverId: first.serverId,
      source: first.source,
      round: first.round,
      inputRequests: requests.map((request) => this.request(request, first)),
      sensitiveInputKeys: [],
      policyDeclinedInputKeys: requests
        .filter((request) => this.resolutions.get(request.requestId)?.decidedBy === "policy")
        .map((request) => request.inputKey ?? ""),
      maxPerRun: [...this.rounds.values()].flat(2).length,
      signal: context.signal,
      ...(first.requestState === undefined ? {} : { requestState: first.requestState }),
    };
  }

  private request(request: RecordedInputRequest, first: RecordedInputRequest) {
    if (
      request.inputKey === undefined ||
      request.serverId !== first.serverId ||
      request.source !== first.source ||
      !sameRecordedJson(request.requestState, first.requestState)
    ) {
      throw new ReplayDivergenceError(request.seq, "input_round_mismatch");
    }
    return {
      inputKey: request.inputKey,
      mode: request.mode,
      message: request.message,
      ...(request.schema === undefined ? {} : { requestedSchema: request.schema }),
      ...(request.url === undefined ? {} : { url: request.url }),
    };
  }

  private verifyPrevious(
    previous: readonly RecordedInputRequest[] | undefined,
    retry: InputRetry,
  ): void {
    if (previous !== undefined) {
      verifyRetry(previous, this.resolutions, retry);
    } else if (retry !== undefined) {
      throw new ReplayDivergenceError(0, "input_round_mismatch");
    }
  }

  private async issue(
    requests: readonly RecordedInputRequest[],
    context: RunContext,
    previous: readonly RecordedInputRequest[] | undefined,
  ) {
    const required = this.required(requests, context);
    if (context.elicitation === undefined || required.round <= (previous?.[0]?.round ?? -1)) {
      throw new ReplayDivergenceError(requests[0]?.seq ?? 0, "input_round_mismatch");
    }
    recordedInputResponses(requests, this.resolutions);
    return { required, outcome: await context.elicitation.handleInputRequired(required) };
  }

  /** Records the next input round through core; true means the tool must remain suspended. */
  async suspend(call: ModelToolCall, context: RunContext): Promise<boolean> {
    if (await this.legacy.replay(call, context)) {
      return false;
    }
    const rounds = this.rounds.get(call.callId) ?? [];
    let position = this.positions.get(call.callId) ?? 0;
    let retry = context.inputRetry;
    for (;;) {
      const previous = rounds[position - 1];
      this.verifyPrevious(previous, retry);
      const requests = rounds[position];
      if (requests === undefined) {
        return false;
      }
      const { required, outcome } = await this.issue(requests, context, previous);
      this.positions.set(call.callId, ++position);
      if (outcome.kind === "suspend") {
        return true;
      }
      if (outcome.kind === "error") {
        throw new ReplayDivergenceError(requests[0]?.seq ?? 0, "input_request_mismatch");
      }
      retry = {
        inputResponses: outcome.inputResponses,
        round: required.round,
        source: required.source ?? "mcp_mrtr",
        ...(required.requestState === undefined ? {} : { requestState: required.requestState }),
      };
    }
  }
}
