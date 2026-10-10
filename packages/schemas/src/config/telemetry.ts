// SPDX-License-Identifier: Apache-2.0
// Sentinel value filtering is owned by task 8.1; gate configuration is owned by task 8.3.
import { z } from "zod";

const TelemetrySentinelConfigSchema = z
  .object({
    minValueLength: z.number().int().min(1).default(6),
    enabled: z.boolean().optional(),
  })
  .strict()
  .prefault({});

export const TelemetryConfigSchema = z
  .object({
    sentinel: TelemetrySentinelConfigSchema,
  })
  .strict()
  .prefault({});

/** Validated telemetry configuration. */
export type TelemetryConfig = z.infer<typeof TelemetryConfigSchema>;
