// SPDX-License-Identifier: Apache-2.0
import type { Code, ModelRequest } from "@harness/schemas";
import { prepareMessagesForProvider } from "./blobs.js";
import type { ModelGatewayContext, RequestSanitizer } from "./gateway.js";

/** Prepares and optionally sanitizes a request for a provider attempt. */
export async function prepareProviderRequest(options: {
  readonly request: ModelRequest;
  readonly provider: Code;
  readonly trust: "hosted" | "local";
  readonly context: ModelGatewayContext;
  readonly sanitizer: RequestSanitizer | undefined;
  readonly signal: AbortSignal;
}): Promise<ModelRequest> {
  const { request, provider, trust, context, sanitizer, signal } = options;
  const preparedRequest = {
    ...request,
    messages: prepareMessagesForProvider(request.messages, provider),
  };
  if (sanitizer === undefined) {
    return preparedRequest;
  }
  return sanitizer(
    preparedRequest,
    { ...request.model, provider, trust },
    {
      runId: context.runId,
      ...(context.recordPiiAction === undefined
        ? {}
        : { recordPiiAction: context.recordPiiAction }),
      signal,
    },
  );
}
