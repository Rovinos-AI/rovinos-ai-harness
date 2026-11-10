// SPDX-License-Identifier: Apache-2.0
import type { Runtime } from "@rovinos/core";
import type { Id } from "@rovinos/schemas";
import { z } from "zod";
import { watchRunStoredEvents } from "./lifecycle.js";
import type { LifecycleTracker } from "./lifecycle.js";
import { contentEntries, readEvents } from "./event-views.js";
import {
  ContentAccessRequestSchema,
  GetRunContentOptionsSchema,
  RunContentSchema,
  RunContentStreamEntrySchema,
  RunIdInputSchema,
  SdkError,
  StreamRunContentOptionsSchema,
  WatchOptionsSchema,
  type ContentAuthorizer,
  type GetRunContentOptions,
  type RunContent,
  type RunContentStreamEntry,
  type StreamRunContentOptions,
} from "./types.js";

const contentAuthorizationDecisionSchema = z.boolean();

/** Reads stored tokenized content after applying the existing explicit access checks. */
export function getRunContent(input: {
  readonly runtime: Runtime;
  readonly runId: string;
  readonly options: GetRunContentOptions;
  readonly piiEnabled: boolean;
  readonly assertAvailable: (runId: Id) => void;
  readonly trackOperation: <Result>(operation: Promise<Result>) => Promise<Result>;
}): Promise<RunContent> {
  const parsedRunId = RunIdInputSchema.parse({ runId: input.runId }).runId;
  input.assertAvailable(parsedRunId);
  GetRunContentOptionsSchema.parse(input.options);
  if (!input.piiEnabled) {
    throw new SdkError("sdk_content_unavailable");
  }
  return input.trackOperation(
    (async () => {
      const events = await readEvents(input.runtime, parsedRunId);
      if (events[0]?.type !== "run_created") {
        throw new SdkError("sdk_run_not_found");
      }
      return RunContentSchema.parse(contentEntries(events));
    })(),
  );
}

/** Validates SDK stream options and constructs the separately authorized content stream. */
export function streamRunContent(input: {
  readonly runtime: Runtime;
  readonly tracker: LifecycleTracker;
  readonly runId: string;
  readonly options: StreamRunContentOptions;
  readonly piiEnabled: boolean;
  readonly contentAuthorizer: ContentAuthorizer | undefined;
  readonly assertOpen: () => void;
  readonly assertAvailable: (runId: Id) => void;
}): AsyncIterable<RunContentStreamEntry> {
  input.assertOpen();
  const runId = RunIdInputSchema.parse({ runId: input.runId }).runId;
  input.assertAvailable(runId);
  return streamRunContentEvents({
    runtime: input.runtime,
    tracker: input.tracker,
    runId,
    options: StreamRunContentOptionsSchema.parse(input.options),
    piiEnabled: input.piiEnabled,
    contentAuthorizer: input.contentAuthorizer,
    assertOpen: input.assertOpen,
  });
}

/** Streams separately authorized content from durable event-log entries. */
export async function* streamRunContentEvents(input: {
  readonly runtime: Runtime;
  readonly tracker: LifecycleTracker;
  readonly runId: Id;
  readonly options: ReturnType<typeof StreamRunContentOptionsSchema.parse>;
  readonly piiEnabled: boolean;
  readonly contentAuthorizer: ContentAuthorizer | undefined;
  readonly assertOpen: () => void;
}): AsyncGenerator<RunContentStreamEntry> {
  const { runtime, tracker, runId, options, piiEnabled, contentAuthorizer, assertOpen } = input;
  const isAborted = (): boolean => options.signal?.aborted === true;
  assertOpen();
  if (!piiEnabled) {
    throw new SdkError("sdk_content_unavailable");
  }
  if (isAborted()) {
    return;
  }
  if (!(await isContentAuthorized(contentAuthorizer, options.principal, runId))) {
    throw new SdkError("sdk_content_access_denied");
  }
  if (isAborted()) {
    return;
  }

  const watchOptions = WatchOptionsSchema.parse({
    fromSeq: options.fromSeq,
    maxBuffered: 1,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  for await (const event of watchRunStoredEvents({
    runtime,
    tracker,
    runId,
    options: watchOptions,
  })) {
    if (isAborted()) {
      return;
    }
    const [entry] = RunContentSchema.parse(contentEntries([event]));
    if (entry === undefined) {
      continue;
    }
    if (!(await isContentAuthorized(contentAuthorizer, options.principal, runId))) {
      throw new SdkError("sdk_content_access_denied");
    }
    if (isAborted()) {
      return;
    }
    yield RunContentStreamEntrySchema.parse({ ...entry, durability: "committed" });
  }
}

async function isContentAuthorized(
  contentAuthorizer: ContentAuthorizer | undefined,
  principal: ReturnType<typeof StreamRunContentOptionsSchema.parse>["principal"],
  runId: Id,
): Promise<boolean> {
  if (contentAuthorizer === undefined) {
    return false;
  }
  try {
    return contentAuthorizationDecisionSchema.parse(
      await contentAuthorizer(ContentAccessRequestSchema.parse({ principal, runId })),
    );
  } catch {
    return false;
  }
}
