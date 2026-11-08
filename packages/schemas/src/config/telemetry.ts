// SPDX-License-Identifier: Apache-2.0
// Sink policies are owned by task 11.1; sentinel settings are owned by tasks 8.1 and 8.3.
// Correlation is opt-in under task 12.8.
import { z } from "zod";
import { Code } from "../primitives.js";

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

/** Policy applied to one configured telemetry sink. */
export const SinkPolicySchema = z
  .object({
    id: Code,
    kind: z.enum(["datadog", "kusto", "stdout", "file"]),
    maxClassification: z.enum(["metadata", "content_tokenized"]).default("metadata"),
    enabled: z.boolean().default(true),
  })
  .strict();

/** Inferred policy for one telemetry sink. */
export type SinkPolicy = z.infer<typeof SinkPolicySchema>;

const TelemetryUnsafeConfigSchema = z
  .object({
    // Content sinks must target a destination with operator-managed access controls.
    allowContentSinks: z.boolean().default(false),
  })
  .strict()
  .prefault({});

export const TelemetryConfigSchema = z
  .object({
    sentinel: TelemetrySentinelConfigSchema,
    correlation: TelemetryCorrelationConfigSchema,
    metrics: TelemetryMetricsConfigSchema,
    sinks: z
      .array(SinkPolicySchema)
      .default([])
      .superRefine((sinks, context) => {
        const seen = new Set<string>();
        for (const [index, sink] of sinks.entries()) {
          if (seen.has(sink.id)) {
            context.addIssue({
              code: "custom",
              path: [index, "id"],
              message: "Sink identifiers must be unique.",
              params: { errorCode: "sink_id_duplicate" },
            });
          }
          seen.add(sink.id);
        }
      }),
    unsafe: TelemetryUnsafeConfigSchema,
  })
  .strict()
  .prefault({});

/** Validated telemetry configuration. */
export type TelemetryConfig = z.infer<typeof TelemetryConfigSchema>;

/** Unparsed telemetry configuration with schema-defaulted properties optional. */
export type TelemetryConfigInput = z.input<typeof TelemetryConfigSchema>;
