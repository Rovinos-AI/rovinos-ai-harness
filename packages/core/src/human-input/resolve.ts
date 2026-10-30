// SPDX-License-Identifier: Apache-2.0
import {
  InputResponseSchema,
  JsonValue as JsonValueSchema,
  Principal,
  type Code,
  type Event,
  type Id,
  type InputRequest,
  type InputResponse,
  type JsonValue,
} from "@rovinos/schemas";
import { formSchemaToZod } from "@rovinos/schemas";
import { LeaseLostError, RunRecorder, type Clock } from "../recorder.js";
import { assertApproverMayResolve } from "../approval-principals.js";
import { foldRunState, type InputRequestedEvent, type RunState, type ToolIntentEvent } from "../run-state.js";
import { INPUT_WAIT_SPAN } from "../spans.js";
import { ensureTracing } from "../runtime-tracing-init.js";
import type { Tokenizer } from "@rovinos/pii";
import type { AuditingVaultResolver } from "@rovinos/vault";
import type { EventStore, RunQueue } from "@rovinos/store";
import { pendingRequest, readRunLog } from "./resolve-log.js";
import {
  inputDestination,
  inputRequestForValidation,
  requestForValidation,
} from "./resolve-validation.js";
import {
  InputAlreadyResolvedError,
  InputAnswerInvalidError,
  InputExpiredError,
  InputNotFoundError,
  InputNotExpiredError,
  InputPrincipalInvalidError,
  InputResolutionConflictError,
  InputTokenizerUnavailableError,
} from "./resolve-errors.js";

export * from "./resolve-errors.js";

/** Options supplied by a human channel when resolving an input. */
export interface InputResolution {
  readonly action: InputResponse["action"];
  readonly answer?: JsonValue | undefined;
  readonly principal: Code;
}

/** Dependencies needed to durably resolve an input from any process. */
export interface InputResolutionDependencies {
  readonly tokenizer?: Pick<Tokenizer, "tokenizeJson">;
  readonly resolver?: AuditingVaultResolver;
  readonly clock?: Clock;
  readonly queue?: Pick<RunQueue, "enqueue">;
  readonly expiresAfterMs?: number;
}

/** A human resolution and the runtime dependencies needed to persist it. */
export interface InputResolutionOptions extends InputResolution, InputResolutionDependencies {}

const systemClock: Clock = { now: Date.now };
const DEFAULT_INPUT_EXPIRY_MS = 604_800_000;

/** Validates a channel response without exposing schema errors or answer content. */
export function validateInputResponse(request: InputRequest, response: unknown): InputResponse {
  const parsed = InputResponseSchema.safeParse(response);
  if (!parsed.success) {
    throw new InputAnswerInvalidError();
  }
  if (parsed.data.action !== "accept") {
    return parsed.data;
  }
  if (request.mode === "url") {
    if (parsed.data.answer !== undefined) {
      throw new InputAnswerInvalidError();
    }
    return parsed.data;
  }
  if (request.schema === undefined || parsed.data.answer === undefined) {
    throw new InputAnswerInvalidError();
  }
  const answer = formSchemaToZod(request.schema).safeParse(parsed.data.answer);
  if (!answer.success || !JsonValueSchema.safeParse(answer.data).success) {
    throw new InputAnswerInvalidError();
  }
  return { action: "accept", answer: JsonValueSchema.parse(answer.data) };
}

async function enqueueResume(
  queue: Pick<RunQueue, "enqueue"> | undefined,
  runId: Id,
): Promise<void> {
  if (queue !== undefined) {
    await queue.enqueue({ kind: "resume", runId });
  }
}

async function enqueueResumeForActiveRun(
  store: EventStore,
  queue: Pick<RunQueue, "enqueue"> | undefined,
  runId: Id,
): Promise<void> {
  if (queue === undefined) {
    return;
  }
  await readRunLog(store, runId);
  await enqueueResume(queue, runId);
}

interface PendingInputResolutionOptions {
  readonly store: EventStore;
  readonly runId: Id;
  readonly requestId: Id;
  readonly resolution:
    | InputResolution
    | { readonly action: "cancel"; readonly decidedBy: "expiry" | "timeout" }
    | { readonly action: "decline"; readonly decidedBy: "policy" };
  readonly dependencies: InputResolutionDependencies;
}

interface RecordInputResolutionOptions {
  readonly store: EventStore;
  readonly runId: Id;
  readonly recorder?: RunRecorder;
  readonly requestId: Id;
  readonly request: InputRequestedEvent;
  readonly response: InputResponse;
  readonly decidedBy: Extract<Event, { type: "input_resolved" }>["decidedBy"];
  readonly approverId?: string;
  readonly answer?: JsonValue;
  readonly state: RunState;
  readonly lastEvent: Event;
  readonly resolvedAt: number;
  readonly waitMs: number;
}

async function recordInputResolution(
  options: RecordInputResolutionOptions,
): Promise<Extract<Event, { type: "input_resolved" }>> {
  const recorder =
    options.recorder ??
    new RunRecorder(
      options.store,
      options.runId,
      options.lastEvent.segmentId,
      options.state.nextSeq,
      { now: () => options.resolvedAt },
    );
  ensureTracing();
  const event = await recorder.withStepSpan(
    INPUT_WAIT_SPAN,
    {
      "harness.input.source": options.request.source,
      "harness.input.mode": options.request.mode,
      "harness.input.round": options.request.round,
      "harness.input.action": options.response.action,
      "harness.wait_ms": options.waitMs,
    },
    () =>
      recorder.record({
        type: "input_resolved",
        v: 1,
        requestId: options.requestId,
        source: options.request.source,
        mode: options.request.mode,
        round: options.request.round,
        action: options.response.action,
        decidedBy: options.decidedBy,
        ...(options.approverId === undefined ? {} : { approverId: options.approverId }),
        waitMs: options.waitMs,
        ...(options.answer === undefined ? {} : { answer: options.answer }),
      }),
  );
  if (event.type !== "input_resolved") {
    throw new InputNotFoundError();
  }
  return event;
}

function inputApprover(
  events: readonly Event[],
  intent: ToolIntentEvent | undefined,
  resolution: PendingInputResolutionOptions["resolution"],
): string | undefined {
  if (!("principal" in resolution)) {
    return undefined;
  }
  const principal = Principal.safeParse(resolution.principal);
  if (!principal.success) {
    throw new InputPrincipalInvalidError();
  }
  assertApproverMayResolve(events[0], intent, {
    decidedBy: "human",
    approverId: principal.data,
  });
  return principal.data;
}

function responseForResolution(
  request: InputRequest,
  resolution: PendingInputResolutionOptions["resolution"],
): InputResponse {
  if (!("principal" in resolution)) {
    return { action: resolution.action };
  }
  return validateInputResponse(request, {
    action: resolution.action,
    ...(resolution.answer === undefined ? {} : { answer: resolution.answer }),
  });
}

function inputExpired(
  request: InputRequestedEvent,
  now: number,
  expiresAfterMs: number | undefined,
): boolean {
  return request.expiresAt !== undefined
    ? request.expiresAt <= now
    : now - request.ts >= (expiresAfterMs ?? DEFAULT_INPUT_EXPIRY_MS);
}

function isHumanResolution(
  resolution: PendingInputResolutionOptions["resolution"],
): resolution is InputResolution {
  return "principal" in resolution;
}

function needsAnswerValidation(
  resolution: PendingInputResolutionOptions["resolution"],
): resolution is InputResolution {
  return (
    isHumanResolution(resolution) &&
    resolution.action === "accept" &&
    resolution.answer !== undefined
  );
}

async function rejectExpiredHumanAnswer(
  options: PendingInputResolutionOptions,
  request: InputRequestedEvent,
  now: number,
): Promise<void> {
  if (
    isHumanResolution(options.resolution) &&
    inputExpired(request, now, options.dependencies.expiresAfterMs)
  ) {
    await resolvePendingInput({
      ...options,
      resolution: { action: "cancel", decidedBy: "expiry" },
    });
    throw new InputExpiredError();
  }
}

async function resolvePendingInputAttempt(
  options: PendingInputResolutionOptions,
): Promise<Extract<Event, { type: "input_resolved" }>> {
  const { store, runId, requestId, resolution, dependencies } = options;
  const clock = dependencies.clock ?? systemClock;
  const { events, state, lastEvent } = await readRunLog(store, runId);
  const request = pendingRequest(state, requestId);
  const decidedBy = "decidedBy" in resolution ? resolution.decidedBy : "human";
  const intent =
    request.callId === undefined ? undefined : state.pendingToolCalls.get(request.callId);
  await rejectExpiredHumanAnswer(options, request, clock.now());
  const destination = needsAnswerValidation(resolution)
    ? inputDestination(request, state)
    : undefined;
  const approverId = inputApprover(events, intent, resolution);
  const recordedRequest = requestForValidation(request);
  const validationRequest = needsAnswerValidation(resolution)
    ? await inputRequestForValidation(runId, recordedRequest, intent, dependencies.resolver)
    : recordedRequest;
  const response = responseForResolution(validationRequest, resolution);
  let answer = response.answer;
  if (answer !== undefined) {
    const tokenizer = dependencies.tokenizer;
    if (tokenizer === undefined) {
      throw new InputTokenizerUnavailableError();
    }
    const tokenized = await tokenizer.tokenizeJson(runId, answer, {
      boundary: "tool_input",
      destination: destination ?? inputDestination(request, state),
      allowRaw: false,
    });
    answer = tokenized.value;
  }

  const resolvedAt = Math.max(0, Math.floor(clock.now()));
  await rejectExpiredHumanAnswer(options, request, resolvedAt);
  const event = await recordInputResolution({
    store,
    runId,
    requestId,
    request,
    response,
    decidedBy,
    ...(approverId === undefined ? {} : { approverId }),
    ...(answer === undefined ? {} : { answer }),
    state,
    lastEvent,
    resolvedAt,
    waitMs: Math.max(0, resolvedAt - request.ts),
  });
  await enqueueResumeForActiveRun(store, dependencies.queue, runId);
  return event;
}

async function resolvePendingInput(
  options: PendingInputResolutionOptions,
): Promise<Extract<Event, { type: "input_resolved" }>> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await resolvePendingInputAttempt(options);
    } catch (error) {
      if (!(error instanceof LeaseLostError)) {
        throw error;
      }
      if (attempt === 2) {
        const latest = await readRunLog(options.store, options.runId);
        pendingRequest(latest.state, options.requestId);
        throw new InputResolutionConflictError();
      }
    }
  }
  throw new InputResolutionConflictError();
}

interface ResumeRecoveryOptions {
  readonly store: EventStore;
  readonly runId: Id;
  readonly requestId: Id;
  readonly dependencies: InputResolutionDependencies;
  readonly resolve: () => Promise<Extract<Event, { type: "input_resolved" }>>;
}

async function resolveWithResumeRecovery({
  store,
  runId,
  requestId,
  dependencies,
  resolve,
}: ResumeRecoveryOptions): Promise<Extract<Event, { type: "input_resolved" }>> {
  try {
    return await resolve();
  } catch (error) {
    if (error instanceof InputAlreadyResolvedError) {
      const { state } = await readRunLog(store, runId);
      if (state.inputRequests.has(requestId)) {
        await enqueueResume(dependencies.queue, runId);
      }
    }
    throw error;
  }
}

/**
 * Appends a validated, tokenized human answer without requiring the run process to be live.
 *
 * @param store - Event store shared by the run and resolver.
 * @param runId - Run containing the input request.
 * @param requestId - Pending request to resolve.
 * @param resolution - Human action, optional answer, and principal identity.
 * @param dependencies - Tokenizer and optional clock and resume queue.
 * @returns The durable input resolution event.
 */
export function resolveInput(
  store: EventStore,
  runId: Id,
  requestId: Id,
  resolution: InputResolutionOptions,
): Promise<Extract<Event, { type: "input_resolved" }>> {
  return resolveWithResumeRecovery({
    store,
    runId,
    requestId,
    dependencies: resolution,
    resolve: () =>
      resolvePendingInput({
        store,
        runId,
        requestId,
        resolution,
        dependencies: resolution,
      }),
  });
}

/** Resolves a live request through the active recorder so its sequence remains contiguous. */
export async function resolveActiveInput(
  recorder: RunRecorder,
  events: Event[],
  history: readonly Event[],
  runId: Id,
  requestId: Id,
  resolution:
    | InputResolution
    | { readonly action: "cancel"; readonly decidedBy: "timeout" }
    | { readonly action: "decline"; readonly decidedBy: "policy" },
  dependencies: InputResolutionDependencies = {},
): Promise<Extract<Event, { type: "input_resolved" }>> {
  const allEvents = [...history, ...events];
  const state = foldRunState(allEvents);
  const request = pendingRequest(state, requestId);
  const lastEvent = allEvents.at(-1);
  if (lastEvent === undefined) {
    throw new InputNotFoundError();
  }
  const intent =
    request.callId === undefined ? undefined : state.pendingToolCalls.get(request.callId);
  const decidedBy = "decidedBy" in resolution ? resolution.decidedBy : "human";
  const approverId = inputApprover(allEvents, intent, resolution);
  const recordedRequest = requestForValidation(request);
  const validationRequest = needsAnswerValidation(resolution)
    ? await inputRequestForValidation(runId, recordedRequest, intent, dependencies.resolver)
    : recordedRequest;
  const response = responseForResolution(validationRequest, resolution);
  let answer = response.answer;
  if (answer !== undefined) {
    const tokenizer = dependencies.tokenizer;
    if (tokenizer === undefined) {
      throw new InputTokenizerUnavailableError();
    }
    const tokenized = await tokenizer.tokenizeJson(runId, answer, {
      boundary: "tool_input",
      destination: inputDestination(request, state),
      allowRaw: false,
    });
    answer = tokenized.value;
  }
  const resolvedAt = Math.max(0, Math.floor((dependencies.clock ?? systemClock).now()));
  const event = await recordInputResolution({
    store: recorder.eventStore,
    runId,
    recorder,
    requestId,
    request,
    response,
    decidedBy,
    ...(approverId === undefined ? {} : { approverId }),
    ...(answer === undefined ? {} : { answer }),
    state,
    lastEvent,
    resolvedAt,
    waitMs: Math.max(0, resolvedAt - request.ts),
  });
  events.push(event);
  return event;
}

/**
 * Resolves a request as cancelled after its absolute expiry or configured age has elapsed.
 *
 * @param store - Event store shared by the run and sweeper.
 * @param runId - Run containing the input request.
 * @param requestId - Input request to expire.
 * @param dependencies - Tokenizer, expiry age, and optional clock and resume queue.
 * @returns The durable expiry resolution event.
 */
export async function expireInput(
  store: EventStore,
  runId: Id,
  requestId: Id,
  dependencies: InputResolutionDependencies & { readonly expiresAfterMs: number },
): Promise<Extract<Event, { type: "input_resolved" }>> {
  const clock = dependencies.clock ?? systemClock;
  return resolveWithResumeRecovery({
    store,
    runId,
    requestId,
    dependencies,
    resolve: async () => {
      const { state } = await readRunLog(store, runId);
      const request = pendingRequest(state, requestId);
      const now = Math.max(0, Math.floor(clock.now()));
      if (!inputExpired(request, now, dependencies.expiresAfterMs)) {
        throw new InputNotExpiredError();
      }
      return resolvePendingInput({
        store,
        runId,
        requestId,
        resolution: { action: "cancel", decidedBy: "expiry" },
        dependencies,
      });
    },
  });
}
