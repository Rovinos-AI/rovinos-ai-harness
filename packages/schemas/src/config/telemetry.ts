// SPDX-License-Identifier: Apache-2.0
// Sentinel settings are owned by tasks 8.1 and 8.3; correlation is opt-in under task 12.8.
import { z } from "zod";

const TelemetrySentinelConfigSchema = z
  .object({
    minValueLength: z.number().int().min(1).default(6),
    enabled: z.boolean().optional(),
  })
  .strict()
  .prefault({});

const TelemetryCorrelationConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
  })
  .strict()
  .prefault({});

// Metrics provider ownership and bounded-series settings are owned by task 11.7.
const TelemetryMetricsConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    ownership: z.enum(["harness", "host"]).default("harness"),
    maxSeries: z.number().int().min(1).max(1_000).default(100),
  })
  .strict()
  .prefault({});

export const TelemetryConfigSchema = z
  .object({
    sentinel: TelemetrySentinelConfigSchema,
    correlation: TelemetryCorrelationConfigSchema,
    metrics: TelemetryMetricsConfigSchema,
  })
  .strict()
  .prefault({});

/** Validated telemetry configuration. */
export type TelemetryConfig = z.infer<typeof TelemetryConfigSchema>;
