// SPDX-License-Identifier: Apache-2.0
import {
  HarnessError,
  InputRequestSchema,
  InputResponseSchema,
  JsonValue as JsonValueSchema,
  Principal,
  type Code,
  type Event,
  type Id,
  type InputRequest,
  type InputResponse,
  type JsonValue,
} from "@harness/schemas";
import { formSchemaToZod } from "@harness/schemas";
import { LeaseLostError, RunRecorder, type Clock } from "../recorder.js";
import { assertApproverMayResolve } from "../approval-principals.js";
import { foldRunState, type InputRequestedEvent, type ToolIntentEvent } from "../run-state.js";
import { INPUT_WAIT_SPAN } from "../spans.js";
import { ensureTracing } from "../runtime-tracing-init.js";
import type { Tokenizer } from "@harness/pii";
import type { EventStore, RunQueue } from "@harness/store";

/** Options supplied by a human channel when resolving an input. */
export interface InputResolution {
  readonly action: InputResponse["action"];
  readonly answer?: JsonValue | undefined;
  readonly principal: Code;
}

/** Dependencies needed to durably resolve an input from any process. */
export interface InputResolutionDependencies {
  readonly tokenizer: Pick<Tokenizer, "tokenizeJson">;
  readonly clock?: Clock;
  readonly queue?: Pick<RunQueue, "enqueue">;
}

/** A human resolution and the runtime dependencies needed to persist it. */
export interface InputResolutionOptions extends InputResolution, InputResolutionDependencies {}

/** Error raised when an input request does not exist in the run log. */
export class InputNotFoundError extends HarnessError {
  readonly code = "input_not_found";

  constructor() {
    super("Input request was not found.");
    this.name = "InputNotFoundError";
  }
}

/** Error raised when an input request has already been resolved. */
export class InputAlreadyResolvedError extends HarnessError {
  readonly code = "input_already_resolved";

  constructor() {
    super("Input request was already resolved.");
    this.name = "InputAlreadyResolvedError";
  }
}

/** Error raised when the selected answer does not satisfy its request schema. */
export class InputAnswerInvalidError extends HarnessError {
  readonly code = "input_answer_invalid";

  constructor() {
    super("Input answer does not satisfy the request schema.");
    this.name = "InputAnswerInvalidError";
  }
}

/** Error raised when a channel's principal is not a valid human principal. */
export class InputPrincipalInvalidError extends HarnessError {
  readonly code = "input_principal_invalid";

  constructor() {
    super("Input resolution requires a valid human principal.");
    this.name = "InputPrincipalInvalidError";
  }
}

/** Error raised when the input has not reached its configured expiry. */
export class InputNotExpiredError extends HarnessError {
  readonly code = "input_not_expired";

  constructor() {
    super("Input request has not expired.");
    this.name = "InputNotExpiredError";
  }
}

/** Error raised when concurrent writers prevent a durable input resolution. */
export class InputResolutionConflictError extends HarnessError {
  readonly code = "input_resolution_conflict";

  constructor() {
    super("Input resolution conflicted with concurrent run events.");
    this.name = "InputResolutionConflictError";
  }
}

const systemClock: Clock = { now: Date.now };

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

interface RunLog {
  readonly events: readonly Event[];
  readonly state: ReturnType<typeof foldRunState>;
  readonly lastEvent: Event;
}

async function readRunLog(store: EventStore, runId: Id): Promise<RunLog> {
  const events: Event[] = [];
  for await (const event of store.read(runId)) {
    events.push(event);
  }
  const lastEvent = events.at(-1);
  if (lastEvent === undefined) {
    throw new InputNotFoundError();
  }
  return { events, state: foldRunState(events), lastEvent };
}

function pendingRequest(
  state: ReturnType<typeof foldRunState>,
  requestId: Id,
): InputRequestedEvent {
  const request = state.pendingInputs.get(requestId);
  if (request !== undefined) {
    return request;
  }
  if (state.inputRequests.has(requestId)) {
    throw new InputAlreadyResolvedError();
  }
  throw new InputNotFoundError();
}

function requestForValidation(event: InputRequestedEvent): InputRequest {
  return InputRequestSchema.parse({
    requestId: event.requestId,
    source: event.source,
    ...(event.serverId === undefined ? {} : { serverId: event.serverId }),
    ...(event.callId === undefined ? {} : { callId: event.callId }),
    ...(event.inputKey === undefined ? {} : { inputKey: event.inputKey }),
    round: event.round,
    mode: event.mode,
    message: event.message,
    ...(event.schema === undefined ? {} : { schema: event.schema }),
    ...(event.url === undefined ? {} : { url: event.url }),
    ...(event.expiresAt === undefined ? {} : { expiresAt: event.expiresAt }),
  });
}

function inputDestination(
  request: InputRequestedEvent,
  state: ReturnType<typeof foldRunState>,
): { readonly tool: Code } | "any" {
  if (request.source === "agent" || request.callId === undefined) {
    return "any";
  }
  const intent = state.pendingToolCalls.get(request.callId);
  return intent === undefined ? "any" : { tool: intent.toolId };
}

async function enqueueResume(
  queue: Pick<RunQueue, "enqueue"> | undefined,
  runId: Id,
): Promise<void> {
  if (queue !== undefined) {
    await queue.enqueue({ kind: "resume", runId });
  }
}

interface PendingInputResolutionOptions {
  readonly store: EventStore;
  readonly runId: Id;
  readonly requestId: Id;
  readonly resolution:
    InputResolution | { readonly action: "cancel"; readonly decidedBy: "expiry" };
  readonly dependencies: InputResolutionDependencies;
}

interface RecordInputResolutionOptions {
  readonly store: EventStore;
  readonly runId: Id;
  readonly requestId: Id;
  readonly request: InputRequestedEvent;
  readonly response: InputResponse;
  readonly decidedBy: Extract<Event, { type: "input_resolved" }>["decidedBy"];
  readonly approverId?: string;
  readonly answer?: JsonValue;
  readonly state: ReturnType<typeof foldRunState>;
  readonly lastEvent: Event;
  readonly resolvedAt: number;
  readonly waitMs: number;
}

async function recordInputResolution(
  options: RecordInputResolutionOptions,
): Promise<Extract<Event, { type: "input_resolved" }>> {
  const recorder = new RunRecorder(
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
  request: InputRequestedEvent,
  resolution: PendingInputResolutionOptions["resolution"],
): InputResponse {
  if (!("principal" in resolution)) {
    return { action: resolution.action };
  }
  return validateInputResponse(requestForValidation(request), {
    action: resolution.action,
    ...(resolution.answer === undefined ? {} : { answer: resolution.answer }),
  });
}

async function resolvePendingInput(
  options: PendingInputResolutionOptions,
): Promise<Extract<Event, { type: "input_resolved" }>> {
  const { store, runId, requestId, resolution, dependencies } = options;
  const clock = dependencies.clock ?? systemClock;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { events, state, lastEvent } = await readRunLog(store, runId);
    const request = pendingRequest(state, requestId);
    const decidedBy = "decidedBy" in resolution ? resolution.decidedBy : "human";
    const intent =
      request.callId === undefined ? undefined : state.pendingToolCalls.get(request.callId);
    const approverId = inputApprover(events, intent, resolution);
    const response = responseForResolution(request, resolution);
    let answer = response.answer;
    if (answer !== undefined) {
      const tokenized = await dependencies.tokenizer.tokenizeJson(runId, answer, {
        boundary: "tool_input",
        destination: inputDestination(request, state),
      });
      answer = tokenized.value;
    }

    const resolvedAt = Math.max(0, Math.floor(clock.now()));
    const waitMs = Math.max(0, resolvedAt - request.ts);
    try {
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
        waitMs,
      });
      await enqueueResume(dependencies.queue, runId);
      return event;
    } catch (error) {
      if (!(error instanceof LeaseLostError)) {
        throw error;
      }
      if (attempt === 2) {
        const latest = await readRunLog(store, runId);
        pendingRequest(latest.state, requestId);
        throw new InputResolutionConflictError();
      }
    }
  }
  throw new InputResolutionConflictError();
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
  return resolvePendingInput({
    store,
    runId,
    requestId,
    resolution,
    dependencies: resolution,
  });
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
  const { state } = await readRunLog(store, runId);
  const request = pendingRequest(state, requestId);
  const now = Math.max(0, Math.floor(clock.now()));
  const expired =
    request.expiresAt !== undefined
      ? request.expiresAt <= now
      : now - request.ts >= dependencies.expiresAfterMs;
  if (!expired) {
    throw new InputNotExpiredError();
  }
  return resolvePendingInput({
    store,
    runId,
    requestId,
    resolution: { action: "cancel", decidedBy: "expiry" },
    dependencies,
  });
}
