// SPDX-License-Identifier: Apache-2.0
import { HarnessError, Principal, type Event, type Id, type InputRequest } from "@harness/schemas";
import type { Tokenizer } from "@harness/pii";
import type { EventStore, RunQueue } from "@harness/store";
import { foldRunState, type InputRequestedEvent } from "../run-state.js";
import type { Clock } from "../recorder.js";
import type { HumanInputChannel } from "./channels.js";
import {
  InputAnswerInvalidError,
  InputAlreadyResolvedError,
  InputNotFoundError,
  resolveInput,
  validateInputResponse,
  type InputResolution,
} from "./resolve.js";

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
  readonly tokenizer: Pick<Tokenizer, "tokenizeJson">;
  readonly clock?: Clock;
  readonly queue?: Pick<RunQueue, "enqueue">;
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

async function presentChannel(
  channel: HumanInputChannel,
  request: InputRequest,
  signal: AbortSignal,
  index: number,
): Promise<{ readonly index: number; readonly response: InputResolution }> {
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
      const validated = validateInputResponse(request, candidate);
      return { index, response: { ...validated, principal: parsedPrincipal.data } };
    } catch (error) {
      if (!(error instanceof InputAnswerInvalidError)) {
        throw error;
      }
    }
  }
  throw new InputPresentationFailedError();
}

async function presentToFirstChannel(
  request: InputRequest,
  channels: readonly HumanInputChannel[],
  signal: AbortSignal,
): Promise<InputResolution> {
  if (signal.aborted) {
    throw signal.reason;
  }
  const activeChannels = channels.map((channel) => ({
    channel,
    controller: new AbortController(),
  }));
  const candidates = activeChannels.map(({ channel, controller }, index) => {
    return presentChannel(channel, request, AbortSignal.any([signal, controller.signal]), index);
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
    const events = await readRunEvents(this.options.store, runId);
    const request = humanRequest(pendingRequest(events, requestId));
    const channels = this.options.channels.filter((channel) => channel.available(request));
    if (channels.length === 0) {
      throw new InputChannelUnavailableError();
    }
    const winner = await presentToFirstChannel(request, channels, signal);
    return resolveInput(this.options.store, runId, requestId, {
      ...winner,
      tokenizer: this.options.tokenizer,
      ...(this.options.clock === undefined ? {} : { clock: this.options.clock }),
      ...(this.options.queue === undefined ? {} : { queue: this.options.queue }),
    });
  }
}
