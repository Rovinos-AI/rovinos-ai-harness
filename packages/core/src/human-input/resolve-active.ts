// SPDX-License-Identifier: Apache-2.0
import { Principal } from "@rovinos/schemas";
import type { Event, Id, InputResponse, JsonValue } from "@rovinos/schemas";
import type { Tokenizer } from "@rovinos/pii";
import type { AuditingVaultResolver } from "@rovinos/vault";
import { assertApproverMayResolve } from "../approval-principals.js";
import type { Clock, RunRecorder } from "../recorder.js";
import {
  foldRunState,
  type InputRequestedEvent,
  type RunState,
  type ToolIntentEvent,
} from "../run-state.js";
import { INPUT_WAIT_SPAN } from "../spans.js";
import { ensureTracing } from "../runtime-tracing-init.js";
import { pendingRequest } from "./resolve-log.js";
import {
  inputDestination,
  inputRequestForValidation,
  requestForValidation,
} from "./resolve-validation.js";
import { validateInputResponse, type InputResolution } from "./resolve.js";
import {
  InputNotFoundError,
  InputPrincipalInvalidError,
  InputTokenizerUnavailableError,
} from "./resolve-errors.js";

type ActiveInputResolution =
  | InputResolution
  | { readonly action: "cancel"; readonly decidedBy: "timeout" }
  | { readonly action: "decline"; readonly decidedBy: "policy" };

interface ResolveActiveInputOptions {
  readonly recorder: RunRecorder;
  readonly events: Event[];
  readonly history: readonly Event[];
  readonly runId: Id;
  readonly requestId: Id;
  readonly resolution: ActiveInputResolution;
  readonly dependencies?: {
    readonly tokenizer?: Pick<Tokenizer, "tokenizeJson">;
    readonly resolver?: AuditingVaultResolver;
    readonly clock?: Clock;
  };
}

interface PreparedActiveResolution {
  readonly approverId?: string;
  readonly response: InputResponse;
  readonly answer?: JsonValue;
}

function activeResolutionNeedsSchema(resolution: ActiveInputResolution): boolean {
  return (
    "principal" in resolution && resolution.action === "accept" && resolution.answer !== undefined
  );
}

async function prepareActiveResolution(options: {
  readonly runId: Id;
  readonly request: InputRequestedEvent;
  readonly state: RunState;
  readonly intent: ToolIntentEvent | undefined;
  readonly resolution: ActiveInputResolution;
  readonly dependencies: NonNullable<ResolveActiveInputOptions["dependencies"]>;
  readonly events: readonly Event[];
}): Promise<PreparedActiveResolution> {
  const { runId, request, state, intent, resolution, dependencies, events } = options;
  const principal =
    "principal" in resolution ? Principal.safeParse(resolution.principal) : undefined;
  if (principal !== undefined && !principal.success) {
    throw new InputPrincipalInvalidError();
  }
  const approverId = principal?.success === true ? principal.data : undefined;
  if (approverId !== undefined) {
    assertApproverMayResolve(events[0], intent, { decidedBy: "human", approverId });
  }
  const recordedRequest = requestForValidation(request);
  const needsSchema = activeResolutionNeedsSchema(resolution);
  const validationRequest = needsSchema
    ? await inputRequestForValidation(runId, recordedRequest, intent, dependencies.resolver)
    : recordedRequest;
  const response: InputResponse =
    "principal" in resolution
      ? validateInputResponse(validationRequest, {
          action: resolution.action,
          ...(resolution.answer === undefined ? {} : { answer: resolution.answer }),
        })
      : { action: resolution.action };
  const answer = await tokenizeActiveAnswer({
    runId,
    request,
    state,
    dependencies,
    answer: response.answer,
  });
  return {
    ...(approverId === undefined ? {} : { approverId }),
    response,
    ...(answer === undefined ? {} : { answer }),
  };
}

async function tokenizeActiveAnswer(options: {
  readonly runId: Id;
  readonly request: InputRequestedEvent;
  readonly state: RunState;
  readonly dependencies: NonNullable<ResolveActiveInputOptions["dependencies"]>;
  readonly answer: JsonValue | undefined;
}): Promise<JsonValue | undefined> {
  let answer = options.answer;
  if (answer !== undefined) {
    if (options.dependencies.tokenizer === undefined) {
      throw new InputTokenizerUnavailableError();
    }
    const tokenized = await options.dependencies.tokenizer.tokenizeJson(options.runId, answer, {
      boundary: "tool_input",
      destination: inputDestination(options.request, options.state),
      allowRaw: false,
    });
    answer = tokenized.value;
  }
  return answer;
}

async function recordActiveResolution(options: {
  readonly recorder: RunRecorder;
  readonly events: Event[];
  readonly request: InputRequestedEvent;
  readonly requestId: Id;
  readonly decidedBy: Extract<Event, { type: "input_resolved" }>["decidedBy"];
  readonly response: InputResponse;
  readonly approverId?: string;
  readonly answer?: JsonValue;
  readonly resolvedAt: number;
}): Promise<Extract<Event, { type: "input_resolved" }>> {
  const waitMs = Math.max(0, options.resolvedAt - options.request.ts);
  ensureTracing();
  const event = await options.recorder.withStepSpan(
    INPUT_WAIT_SPAN,
    {
      "harness.input.source": options.request.source,
      "harness.input.mode": options.request.mode,
      "harness.input.round": options.request.round,
      "harness.input.action": options.response.action,
      "harness.wait_ms": waitMs,
    },
    () =>
      options.recorder.record({
        type: "input_resolved",
        v: 1,
        requestId: options.requestId,
        source: options.request.source,
        mode: options.request.mode,
        round: options.request.round,
        action: options.response.action,
        decidedBy: options.decidedBy,
        ...(options.approverId === undefined ? {} : { approverId: options.approverId }),
        waitMs,
        ...(options.answer === undefined ? {} : { answer: options.answer }),
      }),
  );
  if (event.type !== "input_resolved") {
    throw new InputNotFoundError();
  }
  options.events.push(event);
  return event;
}

/** Resolves a live request through the active recorder so its sequence remains contiguous. */
export async function resolveActiveInput({
  recorder,
  events,
  history,
  runId,
  requestId,
  resolution,
  dependencies = {},
}: ResolveActiveInputOptions): Promise<Extract<Event, { type: "input_resolved" }>> {
  const allEvents = [...history, ...events];
  const state = foldRunState(allEvents);
  const request = pendingRequest(state, requestId);
  const intent =
    request.callId === undefined ? undefined : state.pendingToolCalls.get(request.callId);
  const decidedBy = "decidedBy" in resolution ? resolution.decidedBy : "human";
  const prepared = await prepareActiveResolution({
    runId,
    request,
    state,
    intent,
    resolution,
    dependencies,
    events: allEvents,
  });
  const resolvedAt = Math.max(0, Math.floor((dependencies.clock ?? { now: Date.now }).now()));
  return recordActiveResolution({
    recorder,
    events,
    request,
    requestId,
    decidedBy,
    ...prepared,
    resolvedAt,
  });
}
