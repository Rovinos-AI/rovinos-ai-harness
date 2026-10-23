// SPDX-License-Identifier: Apache-2.0
import { Id, parseJson } from "@harness/schemas";
import type { Code } from "@harness/schemas";
import type { ControlPlanePrincipal } from "../auth.js";
import { RUNS_RESOURCE_URI, RUN_RESOURCE_URI_TEMPLATE } from "./runs.js";
import { z } from "zod";

export const MAX_CONTROL_PLANE_REQUEST_BYTES = 4_194_304;

const McpRequestEnvelopeSchema = z
  .object({ method: z.string(), params: z.unknown().optional() })
  .loose();
const McpRequestBodySchema = z.union([McpRequestEnvelopeSchema, z.array(McpRequestEnvelopeSchema)]);
const ListenResourceSubscriptionsSchema = z
  .object({
    notifications: z.object({ resourceSubscriptions: z.array(z.string()).optional() }).loose(),
  })
  .loose();

/** Checks run-resource subscriptions against the authenticated principal's run scope. */
export function isRunSubscriptionAuthorized(
  body: string,
  principal: ControlPlanePrincipal,
): boolean {
  if (principal.runIds === undefined) {
    return true;
  }
  let message: z.infer<typeof McpRequestBodySchema>;
  try {
    message = parseJson(McpRequestBodySchema, body, {
      maxBytes: MAX_CONTROL_PLANE_REQUEST_BYTES,
    });
  } catch {
    return true;
  }
  const requests = Array.isArray(message) ? message : [message];
  const resourcePrefix = RUN_RESOURCE_URI_TEMPLATE.slice(0, -"{runId}".length);
  for (const request of requests) {
    if (request.method !== "subscriptions/listen") {
      continue;
    }
    const filter = ListenResourceSubscriptionsSchema.safeParse(request.params);
    if (!filter.success) {
      continue;
    }
    for (const uri of filter.data.notifications.resourceSubscriptions ?? []) {
      if (uri === RUNS_RESOURCE_URI || !uri.startsWith(resourcePrefix)) {
        continue;
      }
      const runId = Id.safeParse(uri.slice(resourcePrefix.length));
      if (!runId.success || !principal.runIds.includes(runId.data)) {
        return false;
      }
    }
  }
  return true;
}

/** Returns the run identifier from a valid run-resource URI. */
export function runIdFromResourceUri(uri: string): Id | undefined {
  const resourcePrefix = RUN_RESOURCE_URI_TEMPLATE.slice(0, -"{runId}".length);
  if (!uri.startsWith(resourcePrefix)) {
    return undefined;
  }
  const runId = Id.safeParse(uri.slice(resourcePrefix.length));
  return runId.success ? runId.data : undefined;
}

interface ResourceUpdateHandler {
  readonly notify: {
    resourceUpdated(uri: string): void;
  };
}

/** Notifies only principals authorized for the run that changed. */
export function notifyPrincipalResourceUpdates(
  tokens: readonly { readonly principal: ControlPlanePrincipal }[],
  handlers: ReadonlyMap<Code, ResourceUpdateHandler>,
  uri: string,
): void {
  for (const { principal } of tokens) {
    const handler = handlers.get(principal.tokenId);
    if (handler === undefined) {
      continue;
    }
    const runId = runIdFromResourceUri(uri);
    if (
      principal.runIds !== undefined &&
      (runId === undefined || !principal.runIds.includes(runId))
    ) {
      continue;
    }
    handler.notify.resourceUpdated(uri);
    if (principal.runIds !== undefined) {
      handler.notify.resourceUpdated(RUNS_RESOURCE_URI);
    }
  }
}
