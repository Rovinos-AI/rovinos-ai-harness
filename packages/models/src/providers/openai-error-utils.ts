// SPDX-License-Identifier: Apache-2.0
import { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from "openai";
import { z } from "zod";
import { ProviderError } from "../errors.js";
import { retryAfterMs } from "./retry-after.js";

export const OpenAIErrorMetadataSchema = z.object({
  status: z.number().optional(),
  headers: z.instanceof(Headers).nullish(),
});

const ProviderErrorFrameSchema = z.looseObject({
  type: z.string().optional(),
  code: z.string().optional(),
  error: z.unknown().optional(),
});

/** Returns the provider error type or code from a response frame. */
export function providerErrorType(error: unknown): string | undefined {
  const parsed = ProviderErrorFrameSchema.safeParse(error);
  if (!parsed.success) {
    return undefined;
  }
  const nested = ProviderErrorFrameSchema.safeParse(parsed.data.error);
  return nested.success
    ? (nested.data.type ?? nested.data.code ?? parsed.data.type ?? parsed.data.code)
    : (parsed.data.type ?? parsed.data.code);
}

/** Identifies Azure content-filter error codes without retaining provider text. */
export function isProviderContentFiltered(error: unknown): boolean {
  const providerType = providerErrorType(error);
  return (
    providerType !== undefined &&
    /content.?filter|responsible(?:ai)?policy(?:violation)?/iu.test(providerType)
  );
}

function mapProviderTypeError(
  status: number | undefined,
  headers: Headers | null | undefined,
  nowMs: number,
  providerType?: string,
): ProviderError | undefined {
  if (providerType === "rate_limit_error") {
    const delay = retryAfterMs(headers?.get("retry-after"), nowMs);
    return new ProviderError("provider_rate_limited", {
      ...(status === undefined ? {} : { status }),
      ...(delay === undefined ? {} : { retryAfterMs: delay }),
    });
  }
  if (
    (status === undefined || status === 200 || status >= 500) &&
    (providerType === "overloaded_error" ||
      providerType === "api_error" ||
      providerType === "server_error")
  ) {
    return new ProviderError("provider_unavailable", {
      ...(status === undefined ? {} : { status }),
    });
  }
  return undefined;
}

function mapStatusError(
  status: number | undefined,
  headers: Headers | null | undefined,
  nowMs: number,
  providerType?: string,
): ProviderError {
  const typedError = mapProviderTypeError(status, headers, nowMs, providerType);
  if (typedError !== undefined) {
    return typedError;
  }
  switch (status) {
    case 429: {
      const delay = retryAfterMs(headers?.get("retry-after"), nowMs);
      return new ProviderError("provider_rate_limited", {
        status,
        ...(delay === undefined ? {} : { retryAfterMs: delay }),
      });
    }
    case 408:
    case 504:
      return new ProviderError("provider_timeout", { status });
    case 401:
    case 403:
      return new ProviderError("provider_auth", { status });
    case 400:
      return new ProviderError("provider_bad_request", { status });
    case undefined:
      return new ProviderError("provider_unknown");
    default:
      if (status >= 500) {
        return new ProviderError("provider_unavailable", { status });
      }
      return new ProviderError("provider_unknown", { status });
  }
}

/** Maps OpenAI SDK errors to provider-neutral codes and retry metadata. */
export function mapOpenAIError(error: unknown, nowMs: number): unknown {
  if (error instanceof APIUserAbortError || error instanceof APIConnectionTimeoutError) {
    return new ProviderError("provider_timeout");
  }
  if (error instanceof APIConnectionError) {
    return new ProviderError("provider_unavailable");
  }
  if (!(error instanceof APIError)) {
    return error;
  }

  const metadata = OpenAIErrorMetadataSchema.safeParse(error);
  if (metadata.success && isProviderContentFiltered(error)) {
    return new ProviderError("provider_content_filtered", {
      ...(metadata.data.status === undefined ? {} : { status: metadata.data.status }),
    });
  }
  return metadata.success
    ? mapStatusError(metadata.data.status, metadata.data.headers, nowMs, providerErrorType(error))
    : new ProviderError("provider_unknown");
}
