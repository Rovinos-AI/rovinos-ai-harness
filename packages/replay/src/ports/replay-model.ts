// SPDX-License-Identifier: Apache-2.0
import {
  AdapterRegistry,
  CassetteDivergenceError,
  CassetteMissError,
  CassetteProvider,
  EventLogCassetteStore,
  ModelGateway,
} from "@harness/models";
import type { ModelPort, RunContext } from "@harness/core";
import { HarnessError, type Event, type ModelRequest } from "@harness/schemas";
import type { ResolvedRun } from "../resolve.js";

/** A content-free replay failure with only the recorded sequence. */
export class ReplayDivergenceError extends HarnessError {
  readonly code = "replay_divergence";

  /** @param seq - Sequence of the recorded request. */
  constructor(readonly seq: number) {
    super("The replay request hash differs from the recording.");
  }
}

/** A response expected from the recording is unavailable. */
export class ReplayMissingResultError extends HarnessError {
  readonly code = "replay_missing_result";

  /** @param seq - Sequence associated with the missing recorded response. */
  constructor(readonly seq?: number) {
    super("A recorded replay result is unavailable.");
  }
}

function rootEvents(resolved: ResolvedRun): readonly Event[] {
  return resolved.runs.find(({ runId }) => runId === resolved.rootRunId)?.events ?? [];
}

/** Model port serving tokenized responses through the cassette provider in replay mode only. */
export class ReplayModelPort implements ModelPort {
  readonly alreadyTokenized = true;
  private readonly gateway: ModelGateway;
  private readonly requests: readonly Extract<Event, { type: "model_request" }>[];
  private requestIndex = 0;

  /**
   * @param resolved - Resolved event logs containing the root model request/response pairs.
   * @param dependencies - Replay IDs and clock used by the model gateway.
   */
  constructor(
    resolved: ResolvedRun,
    dependencies: {
      readonly ids: ConstructorParameters<typeof ModelGateway>[1]["ids"];
      readonly clock: ConstructorParameters<typeof ModelGateway>[1]["clock"];
    },
  ) {
    const events = rootEvents(resolved);
    const provider = new CassetteProvider("replay", new EventLogCassetteStore(events));
    this.gateway = new ModelGateway(new AdapterRegistry([provider]), {
      ...dependencies,
      providerStreaming: { cassette: false },
      providerTrust: { cassette: "local" },
    });
    this.requests = events.filter(
      (event): event is Extract<Event, { type: "model_request" }> =>
        event.type === "model_request",
    );
  }

  /** Serves the next cassette response after verifying its full stable request hash. */
  async complete(request: ModelRequest, context: RunContext) {
    const recorded = this.requests[this.requestIndex];
    const seq = recorded?.seq ?? 0;
    try {
      const response = await this.gateway.complete(
        { ...request, model: { ...request.model, provider: "cassette" } },
        context,
      );
      this.requestIndex += 1;
      return response;
    } catch (error) {
      if (error instanceof CassetteDivergenceError) {
        throw new ReplayDivergenceError(seq);
      }
      if (error instanceof CassetteMissError) {
        throw new ReplayMissingResultError(seq);
      }
      throw error;
    }
  }
}
