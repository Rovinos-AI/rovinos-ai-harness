// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { createRuntime, foldRunState, type Runtime } from "@rovinos/core";
import { loadConfig, type HarnessConfig } from "@rovinos/config";
import {
  JsonValue as JsonValueSchema,
  RunInputSchema,
  type Event,
  type Id,
} from "@rovinos/schemas";
import type { SafeEvent } from "@rovinos/telemetry";
import { SdkError } from "./types.js";
import { contentEntries, readEvents, safeEvents } from "./event-views.js";
import { answerPendingInput, resolvePendingApproval } from "./pending-requests.js";
import { runtimeOverridesFrom } from "./runtime-overrides.js";
import {
  CancelRunResultSchema,
  ContinueRunOptionsSchema,
  CreateHarnessOptionsSchema,
  GetRunContentOptionsSchema,
  HarnessOverridesSchema,
  ListRunsFilterSchema,
  RunContentSchema,
  RunIdInputSchema,
  RunPageSchema,
  RunStartResultSchema,
  RunViewSchema,
  StartRunOptionsSchema,
  WatchOptionsSchema,
  type Harness,
  type CreateHarnessOptions,
  type StartRunOptions,
  type ContinueRunOptions,
  type ListRunsFilter,
  type WatchOptions,
  type GetRunContentOptions,
  type ResolveApprovalOptions,
  type AnswerInputOptions,
  type RunStartResult,
} from "./types.js";

const IDEMPOTENCY_ORPHAN_GRACE_MS = 30_000;
const IDEMPOTENCY_START_WAIT_MS = 5_000;
const IDEMPOTENCY_POLL_INTERVAL_MS = 10;

interface ManagedExecution {
  readonly controller: AbortController;
  readonly settled: Promise<void>;
  readonly resolveSettled: () => void;
  tracked: boolean;
}

class HarnessClient implements Harness {
  private readonly idempotencyKeys = new Map<string, Promise<Id>>();
  private readonly managedExecutions = new Set<ManagedExecution>();
  private readonly admittedRunIds = new Set<string>();
  private readonly watchers = new Set<AbortController>();
  private closed = false;
  private disposed = false;
  private closePromise: Promise<void> | undefined;

  constructor(
    private readonly runtime: Runtime,
    private readonly piiEnabled: boolean,
    private readonly correlationEnabled: boolean,
    private readonly shutdownGraceMs: number,
  ) {}

  async startRun(options: StartRunOptions): Promise<RunStartResult> {
    this.assertOpen();
    const input = StartRunOptionsSchema.parse(options);
    const managed = this.admitExecution();
    try {
      const keyHash =
        input.idempotencyKey === undefined
          ? undefined
          : createHash("sha256")
              .update("harness/sdk/idempotency/v1\0")
              .update(input.idempotencyKey)
              .digest("hex");
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
      return await this.launchRun(input, runInput, keyHash, claim?.runId, managed);
    } finally {
      if (!managed.tracked) {
        this.finishExecution(managed);
      }
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

  private projectSafeEvents(events: readonly Event[]) {
    return safeEvents(events, this.correlationEnabled, this.runtime.keys);
  }

  private async launchRun(
    input: StartRunOptions,
    runInput: ReturnType<typeof JsonValueSchema.parse>,
    keyHash: string | undefined,
    candidateRunId: Id | undefined,
    managed: ManagedExecution,
  ): Promise<RunStartResult> {
    const { runId, started, completion } = this.runtime.start(runInput, {
      ...(input.role === undefined ? {} : { role: input.role }),
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
      });
      this.trackExecution(managed, execution.runId, execution.completion);
      const result = await execution.completion;
      const created = result.events.find((event) => event.type === "run_created");
      if (created?.type !== "run_created") {
        throw new SdkError("sdk_run_not_found");
      }
      return RunStartResultSchema.parse({ runId: created.runId, status: result.status });
    } finally {
      if (!managed.tracked) {
        this.finishExecution(managed);
      }
    }
  }

  async getRun(runId: string) {
    const parsedRunId = RunIdInputSchema.parse({ runId }).runId;
    this.assertAvailable(parsedRunId);
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
      usage: state.usage,
      pendingApprovals: Array.from(state.pendingApprovals.keys()),
      recentEvents: await this.projectSafeEvents(events.slice(-20)),
    });
  }

  async listRuns(filter: ListRunsFilter = {}) {
    this.assertAvailable();
    const input = ListRunsFilterSchema.parse(filter);
    const page = await this.runtime.store.listRuns({
      limit: input.limit,
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.continuationOf === undefined ? {} : { continuationOf: input.continuationOf }),
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    });
    return RunPageSchema.parse(page);
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
      if (!managed.tracked) {
        this.finishExecution(managed);
      }
    }
  }

  async cancelRun(runId: string) {
    const parsedRunId = RunIdInputSchema.parse({ runId }).runId;
    this.assertAvailable(parsedRunId);
    return CancelRunResultSchema.parse(await this.runtime.cancel(parsedRunId));
  }

  async resolveApproval(
    approvalId: string,
    decision: Parameters<Harness["resolveApproval"]>[1],
    options: ResolveApprovalOptions,
  ) {
    this.assertOpen();
    return resolvePendingApproval(this.runtime, approvalId, decision, options);
  }

  async answerInput(requestId: string, options: AnswerInputOptions) {
    this.assertOpen();
    return answerPendingInput(this.runtime, requestId, options);
  }

  watch(runId: string, options: WatchOptions = {}): AsyncIterable<SafeEvent> {
    this.assertOpen();
    const parsedRunId = RunIdInputSchema.parse({ runId }).runId;
    this.assertAvailable(parsedRunId);
    const input = WatchOptionsSchema.parse(options);
    return this.watchEvents(parsedRunId, input);
  }

  async getRunContent(runId: string, options: GetRunContentOptions) {
    const parsedRunId = RunIdInputSchema.parse({ runId }).runId;
    this.assertAvailable(parsedRunId);
    GetRunContentOptionsSchema.parse(options);
    if (!this.piiEnabled) {
      throw new SdkError("sdk_content_unavailable");
    }
    const events = await readEvents(this.runtime, parsedRunId);
    if (events[0]?.type !== "run_created") {
      throw new SdkError("sdk_run_not_found");
    }
    return RunContentSchema.parse(contentEntries(events));
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
    if (this.disposed || (this.closed && runId !== undefined && !this.admittedRunIds.has(runId))) {
      throw new SdkError("sdk_closed");
    }
  }

  private admitExecution(): ManagedExecution {
    this.assertOpen();
    let resolveSettled: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    const managed: ManagedExecution = {
      controller: new AbortController(),
      settled,
      resolveSettled,
      tracked: false,
    };
    this.managedExecutions.add(managed);
    return managed;
  }

  private trackExecution(
    managed: ManagedExecution,
    runId: string,
    completion: Promise<unknown>,
  ): void {
    managed.tracked = true;
    this.admittedRunIds.add(runId);
    void completion.then(
      () => this.finishExecution(managed),
      () => this.finishExecution(managed),
    );
  }

  private finishExecution(managed: ManagedExecution): void {
    if (!this.managedExecutions.delete(managed)) {
      return;
    }
    managed.resolveSettled();
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
    const active = Array.from(this.managedExecutions);
    if (active.length > 0) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const expired = await Promise.race([
        Promise.all(active.map(({ settled }) => settled)).then(() => false),
        new Promise<boolean>((resolve) => {
          timeout = setTimeout(() => resolve(true), this.shutdownGraceMs);
        }),
      ]);
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      if (expired) {
        for (const execution of this.managedExecutions) {
          execution.controller.abort("shutdown");
        }
      }
      await Promise.all(Array.from(this.managedExecutions, ({ settled }) => settled));
    }
    this.watchers.forEach((watcher) => watcher.abort());
    try {
      await this.runtime.close();
    } finally {
      this.disposed = true;
    }
  }

  private async *watchEvents(runId: Id, options: ReturnType<typeof WatchOptionsSchema.parse>) {
    if (this.disposed) {
      throw new SdkError("sdk_closed");
    }
    const controller = new AbortController();
    this.watchers.add(controller);
    const onAbort = (): void => {
      controller.abort();
    };
    if (options.signal?.aborted === true) {
      controller.abort();
    } else {
      options.signal?.addEventListener("abort", onAbort, { once: true });
    }
    try {
      let created: Event | undefined;
      for await (const event of this.runtime.store.read(runId)) {
        created = event;
        break;
      }
      if (created?.type !== "run_created") {
        throw new SdkError("sdk_run_not_found");
      }
      if (controller.signal.aborted) {
        return;
      }
      for await (const event of this.runtime.store.watch(runId, {
        fromSeq: options.fromSeq,
        signal: controller.signal,
        ...(options.maxBuffered === undefined ? {} : { maxBuffered: options.maxBuffered }),
      })) {
        yield* await this.projectSafeEvents([event]);
      }
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      this.watchers.delete(controller);
    }
  }
}

/**
 * Creates a validated public SDK around the internal runtime.
 *
 * @param options - Validated config object or config path and optional runtime adapters.
 * @returns Programmatic run, metadata, approval, and subscription operations.
 */
export async function createHarness(options: CreateHarnessOptions): Promise<Harness> {
  const parsedOptions = CreateHarnessOptionsSchema.parse(options);
  const runtimeOverrides = runtimeOverridesFrom(
    HarnessOverridesSchema.parse(parsedOptions.overrides ?? {}),
  );
  const config: HarnessConfig =
    "config" in parsedOptions
      ? parsedOptions.config
      : await loadConfig({ configPath: parsedOptions.configPath });
  const runtime = await createRuntime(config, runtimeOverrides);
  return new HarnessClient(
    runtime,
    config.pii.enabled,
    config.telemetry.correlation.enabled,
    config.run.shutdownGraceMs,
  );
}
