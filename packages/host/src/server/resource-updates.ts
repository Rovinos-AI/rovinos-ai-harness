// SPDX-License-Identifier: Apache-2.0
import { Id, parseJson } from "@harness/schemas";
import { readBody, MAX_HOST_REQUEST_BYTES, writeError } from "./http-utils.js";
import type { AppInstance, HostRequest, HostResponse, ReferenceHostDependencies } from "./types.js";
import { z } from "zod";

const RUNS_RESOURCE_URI = "harness://runs";
const ResourceUpdateSubscriptionSchema = z
  .object({ resourceUri: z.literal(RUNS_RESOURCE_URI), sessionId: Id })
  .strict();

interface ResourceUpdateHandlerOptions {
  readonly dependencies: Pick<ReferenceHostDependencies, "subscribeResourceUpdates">;
  readonly sessions: Map<string, AppInstance>;
  readonly resourceUpdateSubscriptions: Map<string, () => void>;
}

async function readResourceUpdateSubscription(
  request: HostRequest,
  response: HostResponse,
): Promise<z.infer<typeof ResourceUpdateSubscriptionSchema> | undefined> {
  const body = await readBody(request, MAX_HOST_REQUEST_BYTES);
  if (body === undefined) {
    writeError(response, 413, "app_request_too_large");
    return undefined;
  }
  try {
    return parseJson(ResourceUpdateSubscriptionSchema, body, {
      maxBytes: MAX_HOST_REQUEST_BYTES,
    });
  } catch {
    writeError(response, 400, "app_request_invalid");
    return undefined;
  }
}

/** Starts an authenticated SSE stream for run-resource update notifications. */
export async function subscribeResourceUpdates(
  request: HostRequest,
  response: HostResponse,
  options: ResourceUpdateHandlerOptions,
): Promise<void> {
  const subscription = await readResourceUpdateSubscription(request, response);
  if (subscription === undefined) {
    return;
  }
  const instance = options.sessions.get(subscription.sessionId);
  if (instance === undefined) {
    writeError(response, 404, "app_unknown");
    return;
  }
  const subscribe = options.dependencies.subscribeResourceUpdates;
  if (subscribe === undefined) {
    writeError(response, 503, "resource_updates_unavailable");
    return;
  }

  options.resourceUpdateSubscriptions.get(instance.sessionId)?.();
  const state = { writeReady: false, updatePending: false, closed: false };
  let unsubscribe: (() => void) | undefined;
  const writeUpdate = (): void => {
    if (state.closed) {
      return;
    }
    if (state.writeReady) {
      response.write(`data: ${JSON.stringify({ uri: subscription.resourceUri })}\n\n`);
    } else {
      state.updatePending = true;
    }
  };
  const close = (): void => {
    if (state.closed) {
      return;
    }
    state.closed = true;
    options.resourceUpdateSubscriptions.delete(instance.sessionId);
    unsubscribe?.();
    response.end();
  };
  try {
    unsubscribe = subscribe(subscription.resourceUri, writeUpdate, close);
  } catch {
    writeError(response, 503, "resource_updates_unavailable");
    return;
  }
  if (unsubscribe === undefined) {
    writeError(response, 503, "resource_updates_unavailable");
    return;
  }
  options.resourceUpdateSubscriptions.set(instance.sessionId, close);
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-content-type-options": "nosniff",
  });
  response.write(": subscribed\n\n");
  state.writeReady = true;
  if (state.updatePending) {
    writeUpdate();
  }
  const removeCloseListener = response.onClose?.(close);
  if (removeCloseListener === undefined) {
    return;
  }
  const unsubscribeAndRemoveListener = options.resourceUpdateSubscriptions.get(instance.sessionId);
  if (unsubscribeAndRemoveListener !== undefined) {
    options.resourceUpdateSubscriptions.set(instance.sessionId, () => {
      removeCloseListener();
      unsubscribeAndRemoveListener();
    });
  }
}
