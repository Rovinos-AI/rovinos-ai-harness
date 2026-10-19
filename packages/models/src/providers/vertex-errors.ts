// SPDX-License-Identifier: Apache-2.0
import { ApiError } from "@google/genai";
import { JsonValue, parseJson } from "@harness/schemas";
import { ProviderError } from "../errors.js";
import { retryAfterMs } from "./retry-after.js";

const SAFETY_BLOCKS = new Set([
  "BLOCKLIST",
  "IMAGE_SAFETY",
  "PROHIBITED_CONTENT",
  "SAFETY",
  "SPII",
]);

/** Error wrapper retaining only HTTP metadata needed by the adapter mapper. */
export class VertexHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly retryAfter: string | null,
  ) {
    super("vertex_http_error");
    this.name = "VertexHttpError";
  }
}

function containsSafetyBlock(value: JsonValue): boolean {
  if (typeof value === "string") {
    return SAFETY_BLOCKS.has(value.toUpperCase());
  }
  if (Array.isArray(value)) {
    return value.some(containsSafetyBlock);
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value).some(containsSafetyBlock);
  }
  return false;
}

function parsedErrorBody(body: string): JsonValue | undefined {
  try {
    return parseJson(JsonValue, body);
  } catch {
    return undefined;
  }
}

function retryInfoMs(value: JsonValue): number | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const delay = retryInfoMs(entry);
      if (delay !== undefined) {
        return delay;
      }
    }
  } else if (typeof value === "object" && value !== null) {
    const retryDelay = value.retryDelay;
    if (typeof retryDelay === "string") {
      const match = /^(\d+(?:\.\d+)?)s$/.exec(retryDelay);
      if (match?.[1] !== undefined) {
        return Number(match[1]) * 1_000;
      }
    }
    for (const child of Object.values(value)) {
      const delay = retryInfoMs(child);
      if (delay !== undefined) {
        return delay;
      }
    }
  }
  return undefined;
}

function mapHttpStatus(
  status: number,
  body: JsonValue | undefined,
  retryAfter: string | null,
  nowMs: number,
): ProviderError {
  if (status === 400 && body !== undefined && containsSafetyBlock(body)) {
    return new ProviderError("provider_content_filtered", { status });
  }
  if (status === 429) {
    const delay =
      retryAfterMs(retryAfter, nowMs) ?? (body === undefined ? undefined : retryInfoMs(body));
    return new ProviderError("provider_rate_limited", {
      status,
      ...(delay === undefined ? {} : { retryAfterMs: delay }),
    });
  }
  if (status === 401 || status === 403) {
    return new ProviderError("provider_auth", { status });
  }
  if (status === 408 || status === 504) {
    return new ProviderError("provider_timeout", { status });
  }
  if (status === 400 || status === 404) {
    return new ProviderError("provider_bad_request", { status });
  }
  if (status >= 500) {
    return new ProviderError("provider_unavailable", { status });
  }
  return new ProviderError("provider_unknown", { status });
}

function mapUnclassifiedError(error: unknown): ProviderError {
  if (!(error instanceof Error)) {
    return new ProviderError("provider_unknown");
  }
  const causeCode =
    typeof error.cause === "object" && error.cause !== null && "code" in error.cause
      ? error.cause.code
      : undefined;
  if (
    causeCode === "ECONNRESET" ||
    causeCode === "ECONNREFUSED" ||
    causeCode === "EHOSTUNREACH" ||
    causeCode === "ENETUNREACH" ||
    error.message.toLowerCase().includes("fetch failed")
  ) {
    return new ProviderError("provider_unavailable");
  }
  if (
    error.name === "GoogleAuthError" ||
    error.message.toLowerCase().includes("default credentials") ||
    error.message.toLowerCase().includes("application default credentials")
  ) {
    return new ProviderError("provider_auth");
  }
  return new ProviderError("provider_unknown");
}

/** Maps SDK, authentication, transport, and HTTP failures to provider error codes. */
export function mapVertexError(error: unknown, signal: AbortSignal, nowMs: number): ProviderError {
  if (
    signal.aborted ||
    (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))
  ) {
    return new ProviderError("provider_timeout");
  }
  if (error instanceof VertexHttpError) {
    return mapHttpStatus(error.status, parsedErrorBody(error.body), error.retryAfter, nowMs);
  }
  if (error instanceof ApiError) {
    return mapHttpStatus(error.status, parsedErrorBody(error.message), null, nowMs);
  }
  return mapUnclassifiedError(error);
}
