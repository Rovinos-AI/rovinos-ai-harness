// SPDX-License-Identifier: Apache-2.0

/** Pinned OpenTelemetry semantic-conventions package version. */
export const SEMCONV_VERSION = "1.44.0";

// MCP and GenAI conventions are in development and may change; version bumps require a deliberate PR.
/** MCP method attribute name from the pinned semantic-conventions package. */
export const MCP_METHOD_NAME = "mcp.method.name";
/** GenAI provider identifier from the pinned semantic-conventions package. */
export const GEN_AI_PROVIDER_NAME = "gen_ai.provider.name";
/** Configured model identifier from the pinned semantic-conventions package. */
export const GEN_AI_REQUEST_MODEL = "gen_ai.request.model";
/** Input-token count from the pinned semantic-conventions package. */
export const GEN_AI_USAGE_INPUT_TOKENS = "gen_ai.usage.input_tokens";
/** Output-token count from the pinned semantic-conventions package. */
export const GEN_AI_USAGE_OUTPUT_TOKENS = "gen_ai.usage.output_tokens";
/** Cache-read input-token count from the pinned semantic-conventions package. */
export const GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS = "gen_ai.usage.cache_read.input_tokens";
/** Cache-creation input-token count from the pinned semantic-conventions package. */
export const GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS =
  "gen_ai.usage.cache_creation.input_tokens";

/** Span names admitted through the semantic-convention registry path. */
export const SEMCONV_SPAN_NAMES = ["mcp.client.call"] as const;

/** Semantic-convention attribute names admitted by semantic-convention span definitions. */
export const SEMCONV_ATTRIBUTE_NAMES = [
  MCP_METHOD_NAME,
  GEN_AI_PROVIDER_NAME,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
  GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
  GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS,
] as const;

/** Stability migration setting used by the telemetry SDK bootstrap. */
export const SEMCONV_STABILITY_OPT_IN = "http";
