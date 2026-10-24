// SPDX-License-Identifier: Apache-2.0
import {
  AdapterRegistry,
  CassetteDivergenceError,
  CassetteMissError,
  CassetteProvider,
  CassetteStoreReadOnlyError,
  EventLogCassetteStore,
  ModelGateway,
} from "@harness/models";
import type { CassetteEntry, CassetteStore } from "@harness/models";
import type { ModelCompletion, ModelPort, RunContext } from "@harness/core";
import { HarnessError, type Event, type Id, type ModelRequest } from "@harness/schemas";
import type { ResolvedRun } from "../resolve.js";

/** A content-free replay failure with only the recorded sequence. */
export class ReplayDivergenceError extends HarnessError {
  readonly code = "replay_divergence";

  /**
   * @param seq - Sequence of the recorded request.
   * @param hashMismatchCode - Closed category describing which hash differed.
   */
  constructor(
    readonly seq: number,
    readonly hashMismatchCode: "model_request_hash_mismatch" | "tool_args_hash_mismatch",
  ) {
    super("The replay hash differs from the recording.");
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

/** Model port serving tokenized responses through the cassette provider in replay mode only. */
export class ReplayModelPort implements ModelPort {
  readonly alreadyTokenized = true;
  private readonly gateway: ModelGateway;
  private readonly rootReplayRunId: Id;
  private readonly originalRootRunId: Id;
  private readonly requestLogs = new Map<
    Id,
    {
      readonly events: EventLogCassetteStore;
      readonly requests: readonly Extract<Event, { type: "model_request" }>[];
    }
  >();
  private readonly pendingRequests = new Map<
    Id,
    { readonly request: ModelRequest; readonly runId: Id }
  >();
  private readonly requestIndexes = new Map<Id, number>();

  /**
   * @param resolved - Resolved event logs containing the root model request/response pairs.
   * @param dependencies - Replay IDs and clock used by the model gateway.
   */
  constructor(
    resolved: ResolvedRun,
    dependencies: {
      readonly ids: ConstructorParameters<typeof ModelGateway>[1]["ids"];
      readonly clock: ConstructorParameters<typeof ModelGateway>[1]["clock"];
      readonly replayRunId?: Id;
      readonly sourceRunId?: Id;
    },
  ) {
    this.rootReplayRunId = dependencies.replayRunId ?? resolved.rootRunId;
    this.originalRootRunId = dependencies.sourceRunId ?? resolved.rootRunId;
    for (const run of resolved.runs) {
      this.requestLogs.set(run.runId, {
        events: new EventLogCassetteStore(run.events),
        requests: run.events.filter(
          (event): event is Extract<Event, { type: "model_request" }> =>
            event.type === "model_request",
        ),
      });
    }
    const store: CassetteStore = {
      get: (hash, request) => {
        const pending = this.pendingRequests.get(request.requestId);
        if (pending === undefined) {
          return Promise.resolve(undefined);
        }
        const eventLog = this.requestLogs.get(pending.runId);
        return eventLog?.events.get(hash, pending.request) ?? Promise.resolve(undefined);
      },
      set: (_entry: CassetteEntry) => Promise.reject(new CassetteStoreReadOnlyError()),
    };
    const provider = new CassetteProvider("replay", store);
    this.gateway = new ModelGateway(new AdapterRegistry([provider]), {
      ...dependencies,
      providerStreaming: { cassette: false },
      providerTrust: { cassette: "local" },
    });
  }

  /** Serves the next cassette response after verifying its full stable request hash. */
  async complete(request: ModelRequest, context: RunContext): Promise<ModelCompletion> {
    const runId = context.runId === this.rootReplayRunId ? this.originalRootRunId : context.runId;
    const log = this.requestLogs.get(runId);
    const requestIndex = this.requestIndexes.get(runId) ?? 0;
    const recorded = log?.requests[requestIndex];
    const seq = recorded?.seq ?? 0;
    this.pendingRequests.set(request.requestId, { request, runId });
    try {
      const response = await this.gateway.complete(
        { ...request, model: { ...request.model, provider: "cassette" } },
        context,
      );
      this.requestIndexes.set(runId, requestIndex + 1);
      return response;
    } catch (error) {
      if (error instanceof CassetteDivergenceError) {
        throw new ReplayDivergenceError(seq, "model_request_hash_mismatch");
      }
      if (error instanceof CassetteMissError) {
        throw new ReplayMissingResultError(seq);
      }
      throw error;
    } finally {
      this.pendingRequests.delete(request.requestId);
    }
  }
}
