// SPDX-License-Identifier: Apache-2.0
import {
  AccessDeniedException,
  InternalServerException,
  ModelErrorException,
  ModelNotReadyException,
  ModelTimeoutException,
  ResourceNotFoundException,
  ServiceUnavailableException,
  ThrottlingException,
  ValidationException,
} from "@aws-sdk/client-bedrock-runtime";
import { ProviderError } from "../errors.js";

function mapModelError(error: ModelErrorException): ProviderError {
  const status = error.originalStatusCode;
  if (status === 429) {
    return new ProviderError("provider_rate_limited", { status });
  }
  if (status !== undefined && status >= 500) {
    return new ProviderError("provider_unavailable", { status });
  }
  return new ProviderError("provider_bad_request", {
    ...(status === undefined ? {} : { status }),
  });
}

/** Maps Bedrock SDK exceptions to the provider error taxonomy. */
export function mapBedrockError(error: unknown, signal: AbortSignal): ProviderError {
  if (error instanceof ModelTimeoutException) {
    return new ProviderError("provider_timeout", { status: 408 });
  }
  if (signal.aborted || (error instanceof Error && error.name === "AbortError")) {
    return new ProviderError("provider_timeout");
  }
  if (error instanceof ThrottlingException) {
    return new ProviderError("provider_rate_limited", { status: 429 });
  }
  if (error instanceof AccessDeniedException) {
    return new ProviderError("provider_auth", { status: 403 });
  }
  if (error instanceof ValidationException) {
    return new ProviderError("provider_bad_request", { status: 400 });
  }
  if (error instanceof ResourceNotFoundException) {
    return new ProviderError("provider_bad_request", { status: 404 });
  }
  if (
    error instanceof InternalServerException ||
    error instanceof ServiceUnavailableException ||
    error instanceof ModelNotReadyException
  ) {
    return new ProviderError("provider_unavailable", { status: 503 });
  }
  if (error instanceof ModelErrorException) {
    return mapModelError(error);
  }
  return new ProviderError("provider_unknown");
}
