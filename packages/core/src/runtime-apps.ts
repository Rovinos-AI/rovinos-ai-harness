// SPDX-License-Identifier: Apache-2.0
import {
  AppContentEnvelopeSchema,
  Code,
  HarnessError,
  Id,
  JsonValue,
  type Event,
} from "@harness/schemas";
import type { EventStore } from "@harness/store";
import type { Clock } from "./recorder.js";
import { RunRecorder } from "./recorder.js";
import type { RunState } from "./run-state.js";
import { foldRunState } from "./run-state.js";
import { APP_CONTENT_SPAN } from "./spans.js";

/** Tokenizer callback required to accept app content at the model-input boundary. */
export type AppContentTokenize = (
  runId: Id,
  content: JsonValue,
  context: { readonly boundary: "model_input" },
) => Promise<JsonValue>;

/** Content fields accepted from the reference host for durable, labeled recording. */
export type RuntimeAppContent = Pick<
  Extract<Event, { readonly type: "app_content" }>,
  "runId" | "appId" | "kind" | "content"
>;

/** Runtime-owned app callbacks for approval-state checks and untrusted content. */
export interface RuntimeAppCallbacks {
  readonly hasPendingApproval: (runId: Id) => Promise<boolean>;
  readonly tokenizeAppContent: AppContentTokenize;
  readonly onAppContent: (content: RuntimeAppContent) => Promise<void>;
}

class AppContentUnavailableError extends HarnessError {
  override readonly code = "app_content_unavailable";

  constructor() {
    super("App content cannot be processed.");
  }
}

class AppContentRunUnavailableError extends HarnessError {
  override readonly code = "app_content_run_unavailable";

  constructor() {
    super("The app content run is unavailable.");
  }
}

async function runEvents(store: EventStore, runId: Id): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of store.read(runId)) {
    events.push(event);
  }
  return events;
}

function foldedState(events: readonly Event[]): RunState | undefined {
  if (events.length === 0) {
    return undefined;
  }
  return foldRunState(events);
}

async function recordAppContent(
  store: EventStore,
  clock: Clock,
  tokenize: AppContentTokenize | undefined,
  content: RuntimeAppContent,
): Promise<void> {
  if (tokenize === undefined) {
    throw new AppContentUnavailableError();
  }
  const validated = AppContentEnvelopeSchema.parse({
    source: "app",
    label: "App-provided",
    ...content,
  });
  let tokenized: JsonValue;
  try {
    tokenized = JsonValue.parse(
      await tokenize(validated.runId, validated.content, { boundary: "model_input" }),
    );
  } catch {
    throw new AppContentUnavailableError();
  }
  const nextSeq = await store.head(validated.runId);
  if (nextSeq === 0) {
    throw new AppContentRunUnavailableError();
  }
  let lastEvent: Event | undefined;
  for await (const event of store.read(validated.runId, {
    fromSeq: nextSeq - 1,
    toSeq: nextSeq - 1,
  })) {
    lastEvent = event;
  }
  if (lastEvent === undefined) {
    throw new AppContentRunUnavailableError();
  }
  const recorder = new RunRecorder(store, validated.runId, lastEvent.segmentId, nextSeq, clock);
  await recorder.withStepSpan(
    APP_CONTENT_SPAN,
    { "harness.app.id": Code.parse(validated.appId) },
    () =>
      recorder.record({
        type: "app_content",
        v: 1,
        source: "app",
        appId: Code.parse(validated.appId),
        label: "App-provided; untrusted",
        kind: validated.kind,
        content: tokenized,
      }),
  );
}

/**
 * Creates the runtime callbacks used by the reference host.
 *
 * @param store - Event store containing the run's folded state.
 * @param clock - Runtime clock used to timestamp app-content events.
 * @param tokenize - PII tokenizer adapter at the model-input boundary.
 * @returns Host callbacks that fail closed when content tokenization is unavailable.
 */
export function createRuntimeAppCallbacks(options: {
  readonly store: EventStore;
  readonly clock: Clock;
  readonly tokenize?: AppContentTokenize;
}): RuntimeAppCallbacks {
  return {
    hasPendingApproval: async (runId) => {
      try {
        const state = foldedState(await runEvents(options.store, Id.parse(runId)));
        return (state?.pendingApprovals.size ?? 0) > 0;
      } catch {
        return false;
      }
    },
    tokenizeAppContent: async (runId, content, context) => {
      if (options.tokenize === undefined) {
        throw new AppContentUnavailableError();
      }
      try {
        return JsonValue.parse(
          await options.tokenize(Id.parse(runId), JsonValue.parse(content), context),
        );
      } catch {
        throw new AppContentUnavailableError();
      }
    },
    onAppContent: (content) =>
      recordAppContent(options.store, options.clock, options.tokenize, content),
  };
}
