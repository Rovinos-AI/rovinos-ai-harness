// SPDX-License-Identifier: Apache-2.0
import {
  HarnessError,
  Principal,
  type Code,
  type Event,
  type Id,
  type InputRequest,
} from "@rovinos/schemas";
import type { Tokenizer } from "@rovinos/pii";
import type { EventStore, RunQueue } from "@rovinos/store";
import { assertApproverMayResolve } from "../approval-principals.js";
import { foldRunState, type InputRequestedEvent, type ToolIntentEvent } from "../run-state.js";
import type { Clock } from "../recorder.js";
import type { HumanInputChannel } from "./channels.js";
import {
  InputAnswerInvalidError,
  InputAlreadyResolvedError,
  InputNotFoundError,
  resolveInput,
  validateInputResponse,
  type InputResolutionDependencies,
  type InputResolution,
} from "./resolve.js";
import { inputRequestForValidation } from "./resolve-validation.js";

/** Error raised when no registered channel can present a pending request. */
export class InputChannelUnavailableError extends HarnessError {
  readonly code = "input_channel_unavailable";

  constructor() {
    super("No available channel can present this input request.");
    this.name = "InputChannelUnavailableError";
  }
}

/** Error raised when every available channel fails to provide a valid response. */
export class InputPresentationFailedError extends HarnessError {
  readonly code = "input_presentation_failed";

  constructor() {
    super("Input channels could not provide a valid response.");
    this.name = "InputPresentationFailedError";
  }
}

/** Dependencies used by the human-input broker. */
export interface HumanInputBrokerOptions {
  readonly store: EventStore;
  readonly channels: readonly HumanInputChannel[];
  readonly tokenizer?: Pick<Tokenizer, "tokenizeJson">;
  readonly resolver?: InputResolutionDependencies["resolver"];
  readonly clock?: Clock;
  readonly queue?: Pick<RunQueue, "enqueue">;
  readonly expiresAfterMs?: number;
}

async function readRunEvents(store: EventStore, runId: Id): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of store.read(runId)) {
    events.push(event);
  }
  if (events.length === 0) {
    throw new InputNotFoundError();
  }
  return events;
}

function humanRequest(request: InputRequestedEvent): InputRequest {
  return {
    requestId: request.requestId,
    source: request.source,
    ...(request.serverId === undefined ? {} : { serverId: request.serverId }),
    ...(request.callId === undefined ? {} : { callId: request.callId }),
    ...(request.inputKey === undefined ? {} : { inputKey: request.inputKey }),
    round: request.round,
    mode: request.mode,
    message: request.message,
    ...(request.schema === undefined ? {} : { schema: request.schema }),
    ...(request.url === undefined ? {} : { url: request.url }),
    ...(request.expiresAt === undefined ? {} : { expiresAt: request.expiresAt }),
  };
}

function pendingRequest(events: readonly Event[], requestId: Id): InputRequestedEvent {
  const state = foldRunState(events);
  const request = state.pendingInputs.get(requestId);
  if (request !== undefined) {
    return request;
  }
  if (state.inputRequests.has(requestId)) {
    throw new InputAlreadyResolvedError();
  }
  throw new InputNotFoundError();
}

interface PresentChannelOptions {
  readonly channel: HumanInputChannel;
  readonly request: InputRequest;
  readonly validationRequest: InputRequest;
  readonly signal: AbortSignal;
  readonly index: number;
  readonly eligible: (principal: Code) => boolean;
}

async function presentChannel({
  channel,
  request,
  validationRequest,
  signal,
  index,
  eligible,
}: PresentChannelOptions): Promise<{ readonly index: number; readonly response: InputResolution }> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response: unknown = await channel.present(request, signal);
    if (typeof response !== "object" || response === null || Array.isArray(response)) {
      continue;
    }
    if (!("principal" in response)) {
      continue;
    }
    const { principal, ...candidate } = response;
    const parsedPrincipal = Principal.safeParse(principal);
    if (!parsedPrincipal.success) {
      continue;
    }
    try {
      const validated = validateInputResponse(validationRequest, candidate);
      if (!eligible(parsedPrincipal.data)) {
        continue;
      }
      return { index, response: { ...validated, principal: parsedPrincipal.data } };
    } catch (error) {
      if (!(error instanceof InputAnswerInvalidError)) {
        throw error;
      }
    }
  }
  throw new InputPresentationFailedError();
}

interface PresentToFirstChannelOptions {
  readonly request: InputRequest;
  readonly validationRequest: InputRequest;
  readonly channels: readonly HumanInputChannel[];
  readonly signal: AbortSignal;
  readonly eligible: (principal: Code) => boolean;
}

async function presentToFirstChannel({
  request,
  validationRequest,
  channels,
  signal,
  eligible,
}: PresentToFirstChannelOptions): Promise<InputResolution> {
  if (signal.aborted) {
    throw signal.reason;
  }
  const activeChannels = channels.map((channel) => ({
    channel,
    controller: new AbortController(),
  }));
  const candidates = activeChannels.map(({ channel, controller }, index) => {
    return presentChannel({
      channel,
      request,
      validationRequest,
      signal: AbortSignal.any([signal, controller.signal]),
      index,
      eligible,
    });
  });
  let winner: Awaited<(typeof candidates)[number]>;
  try {
    winner = await Promise.any(candidates);
  } catch {
    for (const { controller } of activeChannels) {
      controller.abort();
    }
    signal.throwIfAborted();
    throw new InputPresentationFailedError();
  }
  for (const [index, { controller }] of activeChannels.entries()) {
    if (index !== winner.index) {
      controller.abort();
    }
  }
  signal.throwIfAborted();
  return winner.response;
}

/** Presents pending recorded requests through available channels and durably resolves a winner. */
export class HumanInputBroker {
  constructor(private readonly options: HumanInputBrokerOptions) {}

  /** Returns all pending input requests for a run, including when no channel is available. */
  async listPending(runId: Id): Promise<readonly InputRequest[]> {
    const events = await readRunEvents(this.options.store, runId);
    const state = foldRunState(events);
    return [...state.pendingInputs.values()].map(humanRequest);
  }

  /**
   * Races all capable channels, re-asking once for invalid answers, then records the winner.
   *
   * @param runId - Run containing the request.
   * @param requestId - Pending request presented by this broker.
   * @param signal - Signal that cancels all active channel presentations.
   * @returns The durable resolution event.
   */
  async present(
    runId: Id,
    requestId: Id,
    signal: AbortSignal,
  ): Promise<Extract<Event, { type: "input_resolved" }>> {
    const winner = await this.collect(runId, requestId, signal);
    return resolveInput(this.options.store, runId, requestId, {
      ...winner,
      ...(this.options.tokenizer === undefined ? {} : { tokenizer: this.options.tokenizer }),
      ...(this.options.resolver === undefined ? {} : { resolver: this.options.resolver }),
      ...(this.options.clock === undefined ? {} : { clock: this.options.clock }),
      ...(this.options.expiresAfterMs === undefined
        ? {}
        : { expiresAfterMs: this.options.expiresAfterMs }),
      ...(this.options.queue === undefined ? {} : { queue: this.options.queue }),
    });
  }

  /** Collects a validated channel response without resolving it in a separate event writer. */
  async collect(runId: Id, requestId: Id, signal: AbortSignal): Promise<InputResolution> {
    const events = await readRunEvents(this.options.store, runId);
    const requestEvent = pendingRequest(events, requestId);
    const request = humanRequest(requestEvent);
    const state = foldRunState(events);
    const intent: ToolIntentEvent | undefined =
      requestEvent.callId === undefined
        ? undefined
        : state.pendingToolCalls.get(requestEvent.callId);
    const channels = this.options.channels.filter((channel) => channel.available(request));
    if (channels.length === 0) {
      throw new InputChannelUnavailableError();
    }
    const validationRequest = await inputRequestForValidation(
      runId,
      request,
      intent,
      this.options.resolver,
    );
    const eligible = (principal: Code): boolean => {
      try {
        assertApproverMayResolve(events[0], intent, { decidedBy: "human", approverId: principal });
        return true;
      } catch {
        return false;
      }
    };
    const winner = await presentToFirstChannel({
      request,
      validationRequest,
      channels,
      signal,
      eligible,
    });
    signal.throwIfAborted();
    return winner;
  }
}
