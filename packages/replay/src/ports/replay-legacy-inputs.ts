// SPDX-License-Identifier: Apache-2.0
import { validateInputResponse, type ModelToolCall, type RunContext } from "@rovinos/core";
import { InputRequestSchema, type Event, type Id } from "@rovinos/schemas";
import {
  sameRecordedJson,
  type RecordedInputRequest,
  type RecordedInputResolution,
} from "./replay-inputs.js";
import { ReplayDivergenceError, ReplayMissingResultError } from "./replay-model.js";

/** Replays sequential legacy live requests without inventing MRTR suspension or round semantics. */
export class ReplayLegacyInputs {
  private readonly requests = new Map<Id, RecordedInputRequest[]>();
  private readonly resolutions = new Map<Id, RecordedInputResolution>();

  /** Indexes every legacy round-zero request separately, including reused elicitation keys. */
  constructor(events: readonly Event[]) {
    for (const event of events) {
      if (event.type === "input_resolved") {
        this.resolutions.set(event.requestId, event);
      } else if (
        event.type === "input_requested" &&
        event.source === "mcp_legacy" &&
        event.round === 0 &&
        event.callId !== undefined
      ) {
        const requests = this.requests.get(event.callId) ?? [];
        requests.push(event);
        this.requests.set(event.callId, requests);
      }
    }
  }

  private resolution(request: RecordedInputRequest): RecordedInputResolution {
    const resolution = this.resolutions.get(request.requestId);
    if (resolution === undefined) {
      throw new ReplayMissingResultError(request.seq);
    }
    if (
      resolution.source !== request.source ||
      resolution.mode !== request.mode ||
      resolution.round !== 0
    ) {
      throw new ReplayDivergenceError(request.seq, "input_resolution_mismatch");
    }
    validateInputResponse(
      InputRequestSchema.parse({
        requestId: request.requestId,
        source: request.source,
        callId: request.callId,
        serverId: request.serverId,
        inputKey: request.inputKey,
        round: request.round,
        mode: request.mode,
        message: request.message,
        ...(request.schema === undefined ? {} : { schema: request.schema }),
        ...(request.url === undefined ? {} : { url: request.url }),
      }),
      {
        action: resolution.action,
        ...(resolution.answer === undefined ? {} : { answer: resolution.answer }),
      },
    );
    return resolution;
  }

  /** Runs only core's durable legacy handler and checks the returned recorded token response. */
  async replay(call: ModelToolCall, context: RunContext): Promise<boolean> {
    const requests = this.requests.get(call.callId);
    if (requests === undefined) {
      return false;
    }
    for (const request of requests) {
      const recorded = this.resolution(request);
      if (
        request.serverId === undefined ||
        request.inputKey === undefined ||
        context.elicitation?.handleLegacyLive === undefined ||
        context.inputRetry !== undefined ||
        recorded.decidedBy !== "human"
      ) {
        throw new ReplayDivergenceError(request.seq, "input_round_mismatch");
      }
      const response = await context.elicitation.handleLegacyLive({
        callId: call.callId,
        serverId: request.serverId,
        elicitationId: request.inputKey,
        request: {
          inputKey: request.inputKey,
          mode: request.mode,
          message: request.message,
          ...(request.schema === undefined ? {} : { requestedSchema: request.schema }),
          ...(request.url === undefined ? {} : { url: request.url }),
        },
        timeoutMs: Math.max(1, (request.expiresAt ?? request.ts + 60_000) - request.ts),
        signal: context.signal,
      });
      if (
        response?.action !== recorded.action ||
        !sameRecordedJson(response.answer, recorded.answer)
      ) {
        throw new ReplayDivergenceError(request.seq, "input_resolution_mismatch");
      }
    }
    return true;
  }
}
