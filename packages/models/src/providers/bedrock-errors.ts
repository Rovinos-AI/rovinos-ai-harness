// SPDX-License-Identifier: Apache-2.0
import { ProviderError } from "../errors.js";

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function errorName(error: unknown): string | undefined {
  const name = asObject(error)?.name;
  return typeof name === "string" ? name : undefined;
}

function statusCode(error: unknown): number | undefined {
  const value = asObject(asObject(error)?.$metadata)?.httpStatusCode;
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function readHeader(headers: unknown, name: string): string | undefined {
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }
  const record = asObject(headers);
  const value =
    record === undefined
      ? undefined
      : Object.entries(record).find(([key]) => key.toLowerCase() === name)?.[1];
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

function retryAfterMs(error: unknown): number | undefined {
  const object = asObject(error);
  const value =
    readHeader(asObject(object?.$response)?.headers, "retry-after") ??
    readHeader(asObject(object?.$metadata)?.httpHeaders, "retry-after");
  if (value === undefined) {
    return undefined;
  }
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : undefined;
}

function mapModelError(error: unknown, status: number | undefined): ProviderError {
  const originalStatus = asObject(error)?.originalStatusCode;
  const mappedStatus =
    status ??
    (typeof originalStatus === "number" && Number.isSafeInteger(originalStatus)
      ? originalStatus
      : undefined);
  if (mappedStatus === 429) {
    const delay = retryAfterMs(error);
    return new ProviderError("provider_rate_limited", {
      status: mappedStatus,
      ...(delay === undefined ? {} : { retryAfterMs: delay }),
    });
  }
  if (mappedStatus !== undefined && mappedStatus >= 500) {
    return new ProviderError("provider_unavailable", { status: mappedStatus });
  }
  return new ProviderError("provider_bad_request", {
    ...(mappedStatus === undefined ? {} : { status: mappedStatus }),
  });
}

function cancelledError(): Error {
  const error = new Error("Operation aborted.");
  error.name = "AbortError";
  return error;
}

function mapStatus(status: number | undefined): ProviderError {
  if (status === 429) {
    return new ProviderError("provider_rate_limited", { status });
  }
  if (status === 408 || status === 504) {
    return new ProviderError("provider_timeout", { status });
  }
  if (status === 401 || status === 403) {
    return new ProviderError("provider_auth", { status });
  }
  if (status === 400 || status === 404) {
    return new ProviderError("provider_bad_request", { status });
  }
  if (status !== undefined && status >= 500) {
    return new ProviderError("provider_unavailable", { status });
  }
  return new ProviderError("provider_unknown", {
    ...(status === undefined ? {} : { status }),
  });
}

/** Maps Bedrock SDK exceptions to the provider error taxonomy without retaining provider messages. */
export function mapBedrockError(error: unknown, signal: AbortSignal): ProviderError | Error {
  const name = errorName(error);
  if (signal.aborted || name === "AbortError") {
    return cancelledError();
  }
  const status = statusCode(error);
  switch (name) {
    case "ModelTimeoutException":
      return new ProviderError("provider_timeout", { status: status ?? 408 });
    case "ThrottlingException":
    case "ServiceQuotaExceededException": {
      const delay = retryAfterMs(error);
      return new ProviderError("provider_rate_limited", {
        status: status ?? 429,
        ...(delay === undefined ? {} : { retryAfterMs: delay }),
      });
    }
    case "ModelStreamErrorException": {
      const mapped = mapModelError(error, status);
      const delay = retryAfterMs(error);
      return mapped.code === "provider_bad_request"
        ? new ProviderError("provider_rate_limited", {
            status: status ?? 429,
            ...(delay === undefined ? {} : { retryAfterMs: delay }),
          })
        : mapped;
    }
    case "AccessDeniedException":
      return new ProviderError("provider_auth", { status: status ?? 403 });
    case "ValidationException":
      return new ProviderError("provider_bad_request", { status: status ?? 400 });
    case "ResourceNotFoundException":
      return new ProviderError("provider_bad_request", { status: status ?? 404 });
    case "InternalServerException":
      return new ProviderError("provider_unavailable", { status: status ?? 500 });
    case "ServiceUnavailableException":
    case "ModelNotReadyException":
      return new ProviderError("provider_unavailable", { status: status ?? 503 });
    case "ContentFilteredException":
    case "GuardrailIntervenedException":
      return new ProviderError("provider_content_filtered", { status: status ?? 400 });
    case "ModelErrorException":
      return mapModelError(error, status);
    default:
      return mapStatus(status);
  }
}
