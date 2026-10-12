// SPDX-License-Identifier: Apache-2.0
import { ATTR_MCP_METHOD_NAME } from "@opentelemetry/semantic-conventions/incubating";

/** Pinned OpenTelemetry semantic-conventions package version. */
export const SEMCONV_VERSION = "1.43.0";

// MCP and GenAI conventions are in development and may change; version bumps require a deliberate PR.
/** MCP method attribute name from the pinned semantic-conventions package. */
export const MCP_METHOD_NAME: typeof ATTR_MCP_METHOD_NAME = ATTR_MCP_METHOD_NAME;

/** Span names admitted through the semantic-convention registry path. */
export const SEMCONV_SPAN_NAMES = ["mcp.client.call"] as const;

/** Semantic-convention attribute names admitted by semantic-convention span definitions. */
export const SEMCONV_ATTRIBUTE_NAMES = [MCP_METHOD_NAME] as const;

/** Stability migration setting used by the telemetry SDK bootstrap. */
export const SEMCONV_STABILITY_OPT_IN = "http";
