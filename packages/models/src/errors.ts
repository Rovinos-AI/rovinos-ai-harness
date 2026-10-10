// SPDX-License-Identifier: Apache-2.0
import { HarnessError } from "@harness/schemas";
import { z } from "zod";
import type { EnforcementIssue } from "./enforce/index.js";

/**
 * Closed taxonomy of provider failures understood by the model gateway.
 *
 * | Code | Retryable | Typical HTTP status |
 * | --- | --- | --- |
 * | `provider_rate_limited` | Yes | 429 |
 * | `provider_timeout` | Yes | 408, 504 |
 * | `provider_unavailable` | Yes | 5xx |
 * | `provider_bad_request` | No | 400 |
 * | `provider_auth` | No | 401, 403 |
 * | `provider_content_filtered` | No | 400, 403 |
 * | `provider_unknown` | No | Other or unclassified |
 */
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
  declare readonly retryAfterMs?: number;
  /** HTTP status returned by the provider, when available. */
  declare readonly status?: number;

  /**
   * @param code - Normalized provider failure code.
   * @param options - Optional retry-delay and HTTP status metadata.
   */
  constructor(code: ProviderErrorCode, options: ProviderErrorOptions = {}) {
    super(code);
    this.code = code;
    this.retryable = RETRYABLE_CODES.has(code);
    if (options.retryAfterMs !== undefined) {
      if (!Number.isFinite(options.retryAfterMs) || options.retryAfterMs < 0) {
        throw new RangeError("retryAfterMs must be finite and nonnegative.");
      }
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

/** Raised when structured output remains invalid after the configured repair limit. */
export class ModelOutputInvalidError extends HarnessError {
  /** Stable structured-output failure code. */
  readonly code = "model_output_invalid";
  /** Number of repair calls made after the initial invalid response. */
  readonly repairAttempts: number;
  /** Paths reported by the final value-free validation result. */
  readonly issuePaths: readonly (readonly (string | number)[])[];

  /**
   * @param repairAttempts - Number of repair calls made.
   * @param issues - Value-free issues from the final validation attempt.
   */
  constructor(repairAttempts: number, issues: readonly EnforcementIssue[]) {
    super("Model output did not match the requested schema.");
    this.repairAttempts = repairAttempts;
    this.issuePaths = issues.map(({ path }) => [...path]);
  }
}
