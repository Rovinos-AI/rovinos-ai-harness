// SPDX-License-Identifier: Apache-2.0
import { HarnessError } from "@harness/schemas";
import { z } from "zod";

/** Closed taxonomy of provider failures understood by the model gateway. */
export const ProviderErrorCodeSchema = z.enum([
  "provider_rate_limited",
  "provider_timeout",
  "provider_unavailable",
  "provider_bad_request",
  "provider_auth",
  "provider_content_filtered",
  "provider_unknown",
]);

/** Inferred provider failure code. */
export type ProviderErrorCode = z.infer<typeof ProviderErrorCodeSchema>;

const RETRYABLE_CODES: ReadonlySet<ProviderErrorCode> = new Set([
  "provider_rate_limited",
  "provider_timeout",
  "provider_unavailable",
]);

/** Optional provider metadata attached to a normalized provider error. */
export interface ProviderErrorOptions {
  readonly retryAfterMs?: number;
  readonly status?: number;
}

/** A normalized provider failure with stable retryability and status metadata. */
export class ProviderError extends HarnessError {
  /** Stable provider failure code. */
  readonly code: ProviderErrorCode;
  /** Whether the gateway may retry this failure. */
  readonly retryable: boolean;
  /** Provider-requested retry delay in milliseconds, when supplied. */
  readonly retryAfterMs?: number;
  /** HTTP status returned by the provider, when available. */
  readonly status?: number;

  /**
   * @param code - Normalized provider failure code.
   * @param options - Optional retry-delay and HTTP status metadata.
   */
  constructor(code: ProviderErrorCode, options: ProviderErrorOptions = {}) {
    super(code);
    this.code = code;
    this.retryable = RETRYABLE_CODES.has(code);
    if (options.retryAfterMs !== undefined) {
      this.retryAfterMs = options.retryAfterMs;
    }
    if (options.status !== undefined) {
      this.status = options.status;
    }
  }
}

/** Raised when no adapter is registered for a requested provider. */
export class ProviderNotRegisteredError extends HarnessError {
  /** Stable registry failure code. */
  readonly code = "provider_not_registered";

  /** @param provider - Provider code that has no registered adapter. */
  constructor(provider: string) {
    super(`No adapter is registered for provider ${provider}.`);
  }
}
