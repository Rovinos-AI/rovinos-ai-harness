// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { createRuntime, foldRunState, type Runtime } from "@harness/core";
import { loadConfig, type HarnessConfig } from "@harness/config";
import {
  JsonValue as JsonValueSchema,
  RunInputSchema,
  type Event,
  type Id,
} from "@harness/schemas";
import type { SafeEvent } from "@harness/telemetry";
import { SdkError } from "./types.js";
import { contentEntries, readEvents, safeEvents } from "./event-views.js";
import { runtimeOverridesFrom } from "./runtime-overrides.js";
import {
  AnswerInputOptionsSchema,
  ApprovalIdInputSchema,
  ApprovalDecisionSchema,
  ApprovalResolutionResultSchema,
  CancelRunResultSchema,
  ContinueRunOptionsSchema,
  CreateHarnessOptionsSchema,
  GetRunContentOptionsSchema,
  HarnessOverridesSchema,
  ListRunsFilterSchema,
  ResolveApprovalOptionsSchema,
  RequestIdInputSchema,
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

/**
 * Finds the suspended run for an approval by streaming its log.
 *
 * This lookup is O(suspended runs × events) until the store exposes a direct approval index.
 */
async function findPendingApprovalRun(
  runtime: Runtime,
  approvalId: ReturnType<typeof Id.parse>,
): Promise<ReturnType<typeof Id.parse> | undefined> {
  let cursor: string | undefined;
  do {
    const page = await runtime.store.listRuns({
      status: "suspended",
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const summary of page.runs) {
      let requested = false;
      let resolved = false;
      for await (const event of runtime.store.read(summary.runId)) {
        if (event.type === "approval_requested" && event.approvalId === approvalId) {
          requested = true;
        } else if (event.type === "approval_resolved" && event.approvalId === approvalId) {
          resolved = true;
        }
      }
      if (requested && !resolved) {
        return summary.runId;
      }
    }
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return undefined;
}

class HarnessClient implements Harness {
  private readonly idempotencyKeys = new Map<string, Promise<Id>>();
  private readonly activeRuns = new Map<string, Promise<void>>();
  private readonly watchers = new Set<AbortController>();
  private closed = false;
  private closePromise: Promise<void> | undefined;

  constructor(
    private readonly runtime: Runtime,
    private readonly piiEnabled: boolean,
    private readonly correlationEnabled: boolean,
  ) {}

  async startRun(options: StartRunOptions): Promise<RunStartResult> {
    this.assertOpen();
    const input = StartRunOptionsSchema.parse(options);
    const keyHash =
      input.idempotencyKey === undefined
        ? undefined
        : createHash("sha256")
            .update("harness/sdk/idempotency/v1\0")
            .update(input.idempotencyKey)
            .digest("hex");
    const existingStart = keyHash === undefined ? undefined : this.idempotencyKeys.get(keyHash);
    if (existingStart !== undefined) {
      return this.existingRunResult(await existingStart);
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
    return this.launchRun(input, runInput, keyHash, claim?.runId);
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
  ): Promise<RunStartResult> {
    const { runId, started, completion } = this.runtime.start(runInput, {
      ...(input.role === undefined ? {} : { role: input.role }),
      ...(candidateRunId === undefined ? {} : { runId: candidateRunId }),
      ...(input.requestedBy === undefined ? {} : { requestedBy: input.requestedBy }),
    });
    this.trackRun(runId, completion);
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
    const result = await this.runtime.continueRun(parsedRunId, runInput).completion;
    const created = result.events.find((event) => event.type === "run_created");
    if (created?.type !== "run_created") {
      throw new SdkError("sdk_run_not_found");
    }
    return RunStartResultSchema.parse({ runId: created.runId, status: result.status });
  }

  async getRun(runId: string) {
    this.assertOpen();
    const parsedRunId = RunIdInputSchema.parse({ runId }).runId;
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
    this.assertOpen();
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
    const result = await this.runtime.resume(parsedRunId);
    return RunStartResultSchema.parse({ runId: parsedRunId, status: result.status });
  }

  async cancelRun(runId: string) {
    this.assertOpen();
    const parsedRunId = RunIdInputSchema.parse({ runId }).runId;
    return CancelRunResultSchema.parse(await this.runtime.cancel(parsedRunId));
  }

  async resolveApproval(
    approvalId: string,
    decision: Parameters<Harness["resolveApproval"]>[1],
    options: ResolveApprovalOptions,
  ) {
    this.assertOpen();
    const parsedApprovalId = ApprovalIdInputSchema.parse({ approvalId }).approvalId;
    const parsedDecision = ApprovalDecisionSchema.parse(decision);
    const parsedOptions = ResolveApprovalOptionsSchema.parse(options);
    const runId = await findPendingApprovalRun(this.runtime, parsedApprovalId);
    if (runId === undefined) {
      throw new SdkError("sdk_run_not_found");
    }
    await this.runtime.resolveApproval(runId, parsedApprovalId, parsedDecision, {
      ...(parsedOptions.edits === undefined ? {} : { edits: parsedOptions.edits }),
      metadata: { decidedBy: "human", approverId: parsedOptions.principal },
    });
    return ApprovalResolutionResultSchema.parse({
      runId,
      approvalId: parsedApprovalId,
      decision: parsedDecision,
    });
  }

  async answerInput(requestId: string, options: AnswerInputOptions): Promise<never> {
    this.assertOpen();
    RequestIdInputSchema.parse({ requestId });
    AnswerInputOptionsSchema.parse(options);
    await Promise.resolve();
    throw new SdkError("sdk_input_unavailable");
  }

  watch(runId: string, options: WatchOptions = {}): AsyncIterable<SafeEvent> {
    this.assertOpen();
    const parsedRunId = RunIdInputSchema.parse({ runId }).runId;
    const input = WatchOptionsSchema.parse(options);
    return this.watchEvents(parsedRunId, input);
  }

  async getRunContent(runId: string, options: GetRunContentOptions) {
    this.assertOpen();
    const parsedRunId = RunIdInputSchema.parse({ runId }).runId;
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

  async close(): Promise<void> {
    if (this.closePromise !== undefined) {
      return this.closePromise;
    }
    this.closed = true;
    this.watchers.forEach((watcher) => {
      watcher.abort();
    });
    this.closePromise = this.closeRuntime();
    return this.closePromise;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new SdkError("sdk_closed");
    }
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

  private trackRun(runId: Id, completion: Promise<unknown>): void {
    const settled = completion.then(
      () => undefined,
      () => undefined,
    );
    this.activeRuns.set(runId, settled);
    void settled.then(() => {
      if (this.activeRuns.get(runId) === settled) {
        this.activeRuns.delete(runId);
      }
    });
  }

  private async closeRuntime(): Promise<void> {
    await Promise.all(this.activeRuns.values());
    await this.runtime.close();
  }

  private async *watchEvents(runId: Id, options: ReturnType<typeof WatchOptionsSchema.parse>) {
    if (this.closed) {
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
  return new HarnessClient(runtime, config.pii.enabled, config.telemetry.correlation.enabled);
}
