// SPDX-License-Identifier: Apache-2.0
import { diag, isSpanContextValid, trace, type SpanContext } from "@opentelemetry/api";
import type { ServerConfig } from "@harness/schemas";

const MAX_TRACE_STATE_LENGTH = 512;

/**
 * Builds MCP request metadata, propagating trace context only to opted-in internal servers.
 *
 * Existing non-trace metadata is retained. Trace metadata supplied by callers is removed unless
 * a valid active span context is available for an explicitly trusted server.
 *
 * @param input - Server configuration, active span context, and optional existing request metadata.
 * @returns Sanitized request metadata, or `undefined` when no metadata remains.
 */
export function buildRequestMeta(input: {
  readonly server: ServerConfig;
  readonly spanContext: SpanContext | undefined;
  readonly existingMeta?: Record<string, unknown>;
}): Record<string, unknown> | undefined {
  const meta = { ...input.existingMeta };
  delete meta.baggage;
  delete meta.traceparent;
  delete meta.tracestate;

  if (
    input.server.trust !== "internal" ||
    !input.server.propagateTrace ||
    input.spanContext === undefined ||
    !isSpanContextValid(input.spanContext)
  ) {
    return Object.keys(meta).length === 0 ? undefined : meta;
  }

  const { traceId, spanId, traceFlags, traceState } = input.spanContext;
  const traceparent = `00-${traceId}-${spanId}-${(traceFlags & 0xff).toString(16).padStart(2, "0")}`;
  const serializedState = traceState?.serialize();
  if (serializedState !== undefined && serializedState.length > MAX_TRACE_STATE_LENGTH) {
    diag.debug("MCP tracestate exceeded 512 characters; omitted.");
  } else if (serializedState !== undefined && serializedState.length > 0) {
    meta.tracestate = serializedState;
  }

  meta.traceparent = traceparent;
  return meta;
}

/** Builds request metadata from the currently active call span. */
export function buildActiveRequestMeta(
  server: ServerConfig,
  existingMeta?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  return buildRequestMeta({
    server,
    spanContext: trace.getActiveSpan()?.spanContext(),
    ...(existingMeta === undefined ? {} : { existingMeta }),
  });
}
