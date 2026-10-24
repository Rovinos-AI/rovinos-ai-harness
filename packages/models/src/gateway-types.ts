// SPDX-License-Identifier: Apache-2.0
import type {
  Code,
  Id,
  JsonValue,
  ModelEnforcementConfig,
  ModelRef,
  ModelRequest,
  ModelResponse,
  ModelRetryConfig,
  ModelsConfig,
  PiiActionSummary,
} from "@rovinos/schemas";
import type { z } from "zod";
import type {
  EnforcementResult,
  EnforcementRung,
  TokenizedEnforcementResult,
  ValueTransform,
} from "./enforce/index.js";
import type { PreparedEnforcement } from "./enforce/provider-output.js";
import type { ModelProgress, Clock, IdGenerator, ProviderAdapter } from "./types.js";
import type { TokenBucketRateLimiter } from "./resilience/limiter.js";
import type { Semaphore } from "./resilience/semaphore.js";
import type { Random, Sleep } from "./resilience/retry.js";

/** Dependencies injected into every provider adapter call by the gateway. */
export interface ModelGatewayDependencies {
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly retryPolicy?: ModelRetryConfig;
  readonly enforcement?: ModelEnforcementConfig;
  readonly random?: Random;
  readonly sleep?: Sleep;
  readonly requestsPerMinute?: Readonly<Partial<Record<Code, number>>>;
  readonly maxConcurrent?: number;
  readonly pricing?: ModelsConfig["pricing"];
  readonly providerTrust?: Readonly<Partial<Record<Code, "hosted" | "local">>>;
  readonly providerStreaming?: Readonly<Partial<Record<Code, boolean>>>;
  readonly requestSanitizer?: RequestSanitizer;
}

/** Sanitizes a full provider request for one routed provider attempt. */
export type RequestSanitizer = (
  request: ModelRequest,
  target: ModelRef & { readonly trust: "hosted" | "local" },
  context: {
    readonly runId: Id;
    readonly recordPiiAction?: (summary: PiiActionSummary) => Promise<void>;
    readonly signal: AbortSignal;
  },
) => Promise<ModelRequest>;

/** Shared run, cancellation, and output-validation context for gateway calls. */
export interface ModelGatewayContextBase<OutputSchema extends z.ZodType> {
  readonly runId: Id;
  readonly signal: AbortSignal;
  readonly deadlineTs?: number;
  readonly outputSchema?: OutputSchema;
  readonly recordPiiAction?: (summary: PiiActionSummary) => Promise<void>;
  readonly onProgress?: (progress: ModelProgress) => void;
}

/** Gateway context for ordinary and token-preserving output validation. */
export type ModelGatewayContext<OutputSchema extends z.ZodType = z.ZodType> =
  ModelGatewayContextBase<OutputSchema> &
    ({ readonly valueTransform?: undefined } | { readonly valueTransform: ValueTransform });

/** Gateway context whose validation result remains tokenized. */
export type TokenizedModelGatewayContext<OutputSchema extends z.ZodType = z.ZodType> =
  ModelGatewayContextBase<OutputSchema> & { readonly valueTransform: ValueTransform };

/** Optional gateway retry, enforcement, and telemetry behavior. */
export interface ModelGatewayOptions {
  readonly maxRung?: EnforcementRung;
  readonly deferSpanUsage?: boolean;
}

/** Provider result augmented with output enforcement details. */
export type ModelGatewayResponse<OutputSchema extends z.ZodType = z.ZodType> = ModelResponse & {
  readonly providerBlobs: JsonValue;
  readonly enforcement?: EnforcementResult<OutputSchema>;
};

/** Provider result retaining a tokenized output value. */
export type TokenizedModelGatewayResponse = ModelResponse & {
  readonly providerBlobs: JsonValue;
  readonly enforcement?: TokenizedEnforcementResult;
};

/** Union of responses for ordinary and tokenized structured output. */
export type AnyModelGatewayResponse<OutputSchema extends z.ZodType> =
  ModelGatewayResponse<OutputSchema> | TokenizedModelGatewayResponse;

/** Internal gateway state passed from request preparation to completion. */
export interface PreparedCompletionOptions<OutputSchema extends z.ZodType> {
  readonly request: ModelRequest;
  readonly context: ModelGatewayContext<OutputSchema>;
  readonly adapter: ProviderAdapter;
  readonly prepared: PreparedEnforcement;
  readonly limiter: TokenBucketRateLimiter | undefined;
  readonly semaphore: Semaphore;
}
