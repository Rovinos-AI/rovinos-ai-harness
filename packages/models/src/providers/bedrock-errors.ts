// SPDX-License-Identifier: Apache-2.0
import { ProviderError } from "../errors.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorName(error: unknown): string | undefined {
  const name = isRecord(error) ? error.name : undefined;
  return typeof name === "string" ? name : undefined;
}

function statusCode(error: unknown): number | undefined {
  const metadata = isRecord(error) && isRecord(error.$metadata) ? error.$metadata : undefined;
  const value = metadata?.httpStatusCode;
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function originalStatusCode(error: unknown): number | undefined {
  const value = isRecord(error) ? error.originalStatusCode : undefined;
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function readHeader(headers: unknown, name: string): string | undefined {
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }
  const record = isRecord(headers) ? headers : undefined;
  const value =
    record === undefined
      ? undefined
      : Object.entries(record).find(([key]) => key.toLowerCase() === name)?.[1];
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

function retryAfterMs(error: unknown): number | undefined {
  const object = isRecord(error) ? error : undefined;
  const response = isRecord(object?.$response) ? object.$response : undefined;
  const metadata = isRecord(object?.$metadata) ? object.$metadata : undefined;
  const value =
    readHeader(response?.headers, "retry-after") ??
    readHeader(metadata?.httpHeaders, "retry-after");
  if (value === undefined) {
    return undefined;
  }
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : undefined;
}

function mapModelError(error: unknown, status: number | undefined): ProviderError {
  const mappedStatus = status ?? originalStatusCode(error);
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

type BedrockErrorMapper = (error: unknown, status: number | undefined) => ProviderError;

function mapThrottled(error: unknown, status: number | undefined): ProviderError {
  const delay = retryAfterMs(error);
  return new ProviderError("provider_rate_limited", {
    status: status ?? 429,
    ...(delay === undefined ? {} : { retryAfterMs: delay }),
  });
}

function mapStreamError(error: unknown, status: number | undefined): ProviderError {
  const streamStatus = originalStatusCode(error) ?? status;
  if (streamStatus !== undefined && streamStatus >= 500) {
    return new ProviderError("provider_unavailable", { status: streamStatus });
  }
  return mapThrottled(error, 429);
}

const exceptionMappers: Readonly<Record<string, BedrockErrorMapper>> = {
  ModelTimeoutException: (_error, status) =>
    new ProviderError("provider_timeout", { status: status ?? 408 }),
  ThrottlingException: mapThrottled,
  ServiceQuotaExceededException: mapThrottled,
  ModelStreamErrorException: mapStreamError,
  AccessDeniedException: (_error, status) =>
    new ProviderError("provider_auth", { status: status ?? 403 }),
  ValidationException: (_error, status) =>
    new ProviderError("provider_bad_request", { status: status ?? 400 }),
  ResourceNotFoundException: (_error, status) =>
    new ProviderError("provider_bad_request", { status: status ?? 404 }),
  InternalServerException: (_error, status) =>
    new ProviderError("provider_unavailable", { status: status ?? 500 }),
  ServiceUnavailableException: (_error, status) =>
    new ProviderError("provider_unavailable", { status: status ?? 503 }),
  ModelNotReadyException: (_error, status) =>
    new ProviderError("provider_unavailable", { status: status ?? 503 }),
  ContentFilteredException: (_error, status) =>
    new ProviderError("provider_content_filtered", { status: status ?? 400 }),
  GuardrailIntervenedException: (_error, status) =>
    new ProviderError("provider_content_filtered", { status: status ?? 400 }),
};

/** Maps Bedrock SDK exceptions to the provider error taxonomy without retaining provider messages. */
export function mapBedrockError(error: unknown, signal: AbortSignal): ProviderError | Error {
  const name = errorName(error);
  if (signal.aborted || name === "AbortError") {
    return cancelledError();
  }
  const status = statusCode(error);
  if (name === "ModelErrorException") {
    return mapModelError(error, status);
  }
  return (
    (name === undefined ? undefined : exceptionMappers[name])?.(error, status) ?? mapStatus(status)
  );
}
