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

export const TelemetryConfigSchema = z
  .object({
    sentinel: TelemetrySentinelConfigSchema,
    correlation: TelemetryCorrelationConfigSchema,
  })
  .strict()
  .prefault({});

/** Validated telemetry configuration. */
export type TelemetryConfig = z.infer<typeof TelemetryConfigSchema>;
