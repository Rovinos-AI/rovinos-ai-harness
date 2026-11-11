// SPDX-License-Identifier: Apache-2.0
import { performance } from "node:perf_hooks";
import { foldRunState, type Runtime } from "@rovinos/core";
import { JsonValue as JsonValueSchema, RunInputSchema, type Id } from "@rovinos/schemas";
import type { SafeEvent } from "@rovinos/telemetry";
import { projectSafeEvents, readEvents } from "./event-views.js";
import { getRunContent as readRunContent, streamRunContent } from "./content-access.js";
import { answerPendingInput, resolvePendingApproval } from "./pending-requests.js";
import { idempotencyKeyHash } from "./idempotency.js";
import { LifecycleTracker, watchRunEvents } from "./lifecycle.js";
import { projectRunViewUsage } from "./run-view-usage.js";
import {
  ExtensionHarnessAccess,
  type ExtensionHarnessAccessOptions,
} from "./extension-harness-access.js";
import {
  CancelRunResultSchema,
  ContinueRunOptionsSchema,
  ListRunsFilterSchema,
  RunIdInputSchema,
  RunPageSchema,
  RunStartResultSchema,
  RunViewSchema,
  StartRunOptionsSchema,
  WatchOptionsSchema,
  SdkError,
  type Harness,
  type StartRunOptions,
  type ContinueRunOptions,
  type ListRunsFilter,
  type WatchOptions,
  type GetRunContentOptions,
  type ContentAuthorizer,
  type RunContentStreamEntry,
  type StreamRunContentOptions,
  type ResolveApprovalOptions,
  type AnswerInputOptions,
  type RunStartResult,
} from "./types.js";

const IDEMPOTENCY_ORPHAN_GRACE_MS = 30_000;
const IDEMPOTENCY_START_WAIT_MS = 5_000;
const IDEMPOTENCY_POLL_INTERVAL_MS = 10;

class HarnessClient extends ExtensionHarnessAccess implements Harness {
  private readonly idempotencyKeys = new Map<string, Promise<Id>>();
  private readonly lifecycle: LifecycleTracker;
  private readonly admittedRunIds = new Set<string>();
  private closed = false;
  private drainingFinished = false;
  private disposed = false;
  private closePromise: Promise<void> | undefined;

  constructor(input: Parameters<typeof createHarnessClient>[0]) {
    super(input);
    this.runtime = input.runtime;
    this.piiEnabled = input.piiEnabled;
    this.correlationEnabled = input.correlationEnabled;
    this.contentAuthorizer = input.contentAuthorizer;
    this.lifecycle = new LifecycleTracker(input.shutdownGraceMs);
  }

  private readonly runtime: Runtime;
  private readonly piiEnabled: boolean;
  private readonly correlationEnabled: boolean;
  private readonly contentAuthorizer: ContentAuthorizer | undefined;

  async startRun(options: StartRunOptions): Promise<RunStartResult> {
    this.assertOpen();
    const input = StartRunOptionsSchema.parse(options);
    const managed = this.admitExecution();
    try {
      const keyHash =
        input.idempotencyKey === undefined
          ? undefined
          : idempotencyKeyHash(input.idempotencyKey, input.toolProfile);
      const existingStart = keyHash === undefined ? undefined : this.idempotencyKeys.get(keyHash);
      if (existingStart !== undefined) {
        return await this.existingRunResult(await existingStart);
      }

      const runInput = JsonValueSchema.parse(
        RunInputSchema.parse({
          goal: input.goal,
          ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
        }),
      );
      const claim = keyHash === undefined ? undefined : await this.claimOrRecoverStart(keyHash);
      if (claim !== undefined && "result" in claim) {
        return claim.result;
      }
      return await this.launchRun({
        input,
        runInput,
        keyHash,
        candidateRunId: claim?.runId,
        managed,
      });
    } finally {
      this.lifecycle.finishIfUntracked(managed);
    }
  }

  private async claimOrRecoverStart(
    keyHash: string,
  ): Promise<{ readonly runId: Id } | { readonly result: RunStartResult }> {
    const candidateRunId = this.runtime.ids.next();
    const claimedRunId = await this.runtime.store.claimIdempotencyKey(
      keyHash,
      candidateRunId,
      this.runtime.clock.now(),
    );
    if (claimedRunId === candidateRunId) {
      return { runId: candidateRunId };
    }
    const result = await this.waitForExistingStart(keyHash, claimedRunId, candidateRunId);
    return result === undefined ? { runId: candidateRunId } : { result };
  }

  private async launchRun(options: {
    readonly input: StartRunOptions;
    readonly runInput: ReturnType<typeof JsonValueSchema.parse>;
    readonly keyHash: string | undefined;
    readonly candidateRunId: Id | undefined;
    readonly managed: ReturnType<LifecycleTracker["admitExecution"]>;
  }): Promise<RunStartResult> {
    const { input, runInput, keyHash, candidateRunId, managed } = options;
    const { runId, started, completion } = this.runtime.start(runInput, {
      ...(input.role === undefined ? {} : { role: input.role }),
      ...(input.toolProfile === undefined ? {} : { toolProfile: input.toolProfile }),
      ...(candidateRunId === undefined ? {} : { runId: candidateRunId }),
      ...(input.requestedBy === undefined ? {} : { requestedBy: input.requestedBy }),
      signal: managed.controller.signal,
    });
    this.trackExecution(managed, runId, completion);
    const start = started.then(() => runId);
    if (keyHash !== undefined) {
      this.idempotencyKeys.set(keyHash, start);
    }
    try {
      await start;
    } catch (error) {
      if (keyHash !== undefined) {
        try {
          if ((await this.runtime.store.head(runId)) === 0) {
            await this.runtime.store.releaseIdempotencyKey(keyHash, runId);
          }
        } catch {
          // Keep the claim when the append outcome cannot be established.
        }
      }

      throw error;
    } finally {
      if (keyHash !== undefined && this.idempotencyKeys.get(keyHash) === start) {
        this.idempotencyKeys.delete(keyHash);
      }
    }
    return RunStartResultSchema.parse({ runId, status: "pending" });
  }

  async continueRun(runId: string, options: ContinueRunOptions): Promise<RunStartResult> {
    this.assertOpen();
    const parsedRunId = RunIdInputSchema.parse({ runId }).runId;
    const input = ContinueRunOptionsSchema.parse(options);
    const runInput = RunInputSchema.parse({
      goal: input.goal,
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    });
    const managed = this.admitExecution();
    this.admittedRunIds.add(parsedRunId);
    try {
      const execution = this.runtime.continueRun(parsedRunId, runInput, {
        signal: managed.controller.signal,
        ...(input.toolProfile === undefined ? {} : { toolProfile: input.toolProfile }),
      });
      this.trackExecution(managed, execution.runId, execution.completion);
      const result = await execution.completion;
      const created = result.events.find((event) => event.type === "run_created");
      if (created?.type !== "run_created") {
        throw new SdkError("sdk_run_not_found");
      }
      return RunStartResultSchema.parse({ runId: created.runId, status: result.status });
    } finally {
      this.lifecycle.finishIfUntracked(managed);
    }
  }

  async getRun(runId: string) {
    const parsedRunId = RunIdInputSchema.parse({ runId }).runId;
    this.assertAvailable(parsedRunId);
    return this.lifecycle.trackOperation(
      (async () => {
        const events = await readEvents(this.runtime, parsedRunId);
        const firstEvent = events[0];
        const lastEvent = events.at(-1);
        if (firstEvent?.type !== "run_created" || lastEvent === undefined) {
          throw new SdkError("sdk_run_not_found");
        }
        const state = foldRunState(events);
        return RunViewSchema.parse({
          runId: parsedRunId,
          createdAt: firstEvent.ts,
          status: state.status,
          lastSeq: lastEvent.seq,
          lastTs: lastEvent.ts,
          steps: state.steps,
          usage: projectRunViewUsage(state.usage),
          pendingApprovals: Array.from(state.pendingApprovals.keys()),
          recentEvents: await projectSafeEvents(
            this.runtime,
            events.slice(-20),
            this.correlationEnabled,
          ),
        });
      })(),
    );
  }

  async listRuns(filter: ListRunsFilter = {}) {
    this.assertAvailable();
    const input = ListRunsFilterSchema.parse(filter);
    return this.lifecycle.trackOperation(
      this.runtime.store
        .listRuns({
          limit: input.limit,
          ...(input.status === undefined ? {} : { status: input.status }),
          ...(input.continuationOf === undefined ? {} : { continuationOf: input.continuationOf }),
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        })
        .then((page) => RunPageSchema.parse(page)),
    );
  }

  async resumeRun(runId: string): Promise<RunStartResult> {
    this.assertOpen();
    const parsedRunId = RunIdInputSchema.parse({ runId }).runId;
    const managed = this.admitExecution();
    this.admittedRunIds.add(parsedRunId);
    try {
      const completion = this.runtime.resume(parsedRunId, { signal: managed.controller.signal });
      this.trackExecution(managed, parsedRunId, completion);
      const result = await completion;
      return RunStartResultSchema.parse({ runId: parsedRunId, status: result.status });
    } finally {
      this.lifecycle.finishIfUntracked(managed);
    }
  }

  async cancelRun(runId: string) {
    const parsedRunId = RunIdInputSchema.parse({ runId }).runId;
    this.assertAvailable(parsedRunId);
    return this.lifecycle.trackOperation(
      this.runtime.cancel(parsedRunId).then((result) => CancelRunResultSchema.parse(result)),
    );
  }

  async resolveApproval(
    approvalId: string,
    decision: Parameters<Harness["resolveApproval"]>[1],
    options: ResolveApprovalOptions,
  ) {
    this.assertOpen();
    return this.lifecycle.trackOperation(
      resolvePendingApproval(this.runtime, approvalId, decision, options),
    );
  }

  async answerInput(requestId: string, options: AnswerInputOptions) {
    this.assertOpen();
    return this.lifecycle.trackOperation(answerPendingInput(this.runtime, requestId, options));
  }

  watch(runId: string, options: WatchOptions = {}): AsyncIterable<SafeEvent> {
    this.assertOpen();
    const parsedRunId = RunIdInputSchema.parse({ runId }).runId;
    this.assertAvailable(parsedRunId);
    const input = WatchOptionsSchema.parse(options);
    return this.watchEvents(parsedRunId, input);
  }

  async getRunContent(runId: string, options: GetRunContentOptions) {
    return readRunContent({
      runtime: this.runtime,
      runId,
      options,
      piiEnabled: this.piiEnabled,
      assertAvailable: (parsedRunId) => {
        this.assertAvailable(parsedRunId);
      },
      trackOperation: (operation) => this.lifecycle.trackOperation(operation),
    });
  }

  streamRunContent(
    runId: string,
    options: StreamRunContentOptions,
  ): AsyncIterable<RunContentStreamEntry> {
    return streamRunContent({
      runtime: this.runtime,
      tracker: this.lifecycle,
      runId,
      options,
      piiEnabled: this.piiEnabled,
      contentAuthorizer: this.contentAuthorizer,
      assertOpen: this.assertOpen.bind(this),
      assertAvailable: this.assertAvailable.bind(this),
    });
  }

  close(): Promise<void> {
    if (this.closePromise !== undefined) {
      return this.closePromise;
    }
    this.closed = true;
    this.closePromise = this.closeRuntime();
    return this.closePromise;
  }

  private assertOpen(): void {
    if (this.closed || this.disposed) {
      throw new SdkError("sdk_closed");
    }
  }

  private assertAvailable(runId?: string): void {
    if (
      this.disposed ||
      (this.closed &&
        (this.drainingFinished || (runId !== undefined && !this.admittedRunIds.has(runId))))
    ) {
      throw new SdkError("sdk_closed");
    }
  }

  private admitExecution(): ReturnType<LifecycleTracker["admitExecution"]> {
    this.assertOpen();
    return this.lifecycle.admitExecution();
  }

  private trackExecution(
    managed: ReturnType<LifecycleTracker["admitExecution"]>,
    runId: string,
    completion: Promise<unknown>,
  ): void {
    this.admittedRunIds.add(runId);
    this.lifecycle.trackExecution(managed, completion);
  }

  private async existingRunResult(runId: Id): Promise<RunStartResult> {
    let status: RunStartResult["status"] = "pending";
    try {
      status = (await this.getRun(runId)).status;
    } catch (error) {
      if (!(error instanceof SdkError) || error.code !== "sdk_run_not_found") {
        throw error;
      }
    }
    return RunStartResultSchema.parse({ runId, status });
  }

  private async waitForExistingStart(
    keyHash: string,
    initialRunId: Id,
    candidateRunId: Id,
  ): Promise<RunStartResult | undefined> {
    let runId = initialRunId;
    const deadline = performance.now() + IDEMPOTENCY_START_WAIT_MS;
    while (performance.now() < deadline) {
      if ((await this.runtime.store.head(runId)) > 0) {
        return this.existingRunResult(runId);
      }
      const now = this.runtime.clock.now();
      if (
        await this.runtime.store.takeoverIdempotencyKey(keyHash, {
          expectedRunId: runId,
          runId: candidateRunId,
          createdAt: now,
          staleBefore: now - IDEMPOTENCY_ORPHAN_GRACE_MS,
        })
      ) {
        return undefined;
      }
      runId = await this.runtime.store.claimIdempotencyKey(keyHash, candidateRunId, now);
      if (runId === candidateRunId) {
        return undefined;
      }
      await new Promise((resolve) => setTimeout(resolve, IDEMPOTENCY_POLL_INTERVAL_MS));
    }
    throw new SdkError("sdk_run_not_found");
  }

  private async closeRuntime(): Promise<void> {
    await this.lifecycle.drainExecutions();
    this.drainingFinished = true;
    await this.lifecycle.stopWatchers();
    await this.lifecycle.waitForOperations();
    try {
      await this.runtime.close();
    } finally {
      this.disposed = true;
    }
  }

  private async *watchEvents(runId: Id, options: ReturnType<typeof WatchOptionsSchema.parse>) {
    if (this.closed || this.disposed) {
      throw new SdkError("sdk_closed");
    }
    yield* watchRunEvents({
      runtime: this.runtime,
      tracker: this.lifecycle,
      runId,
      options,
      projectSafeEvents: (events) =>
        projectSafeEvents(this.runtime, events, this.correlationEnabled),
    });
  }
}

/** Creates the internal SDK client around a validated runtime. */
export function createHarnessClient(
  input: {
    readonly runtime: Runtime;
    readonly piiEnabled: boolean;
    readonly correlationEnabled: boolean;
    readonly shutdownGraceMs: number;
    readonly contentAuthorizer: ContentAuthorizer | undefined;
  } & ExtensionHarnessAccessOptions,
): Harness {
  return new HarnessClient(input);
}
