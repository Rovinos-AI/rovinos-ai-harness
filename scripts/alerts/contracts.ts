// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

export const ALERT_IDS = [
  "leak_sentinel",
  "rejected_app_spans",
  "pii_detector_degraded",
  "budget_exceeded",
  "approval_wait",
  "provider_error",
  "no_telemetry",
] as const;

export const AlertIdSchema = z.enum(ALERT_IDS);
/** Identifier shared by threshold, generated monitor, and runbook contracts. */
export type AlertId = z.infer<typeof AlertIdSchema>;

const AlertThresholdSchema = z
  .object({
    window_minutes: z.number().int().positive(),
    critical: z.number().nonnegative(),
    priority: z.number().int().min(1).max(5),
  })
  .strict();

export const AlertThresholdsSchema = z
  .object({
    leak_sentinel: AlertThresholdSchema,
    rejected_app_spans: AlertThresholdSchema,
    pii_detector_degraded: AlertThresholdSchema,
    budget_exceeded: AlertThresholdSchema,
    approval_wait: AlertThresholdSchema,
    provider_error: AlertThresholdSchema,
    no_telemetry: AlertThresholdSchema,
  })
  .strict();

/** Validated tunable thresholds for all supported alerts. */
export type AlertThresholds = z.infer<typeof AlertThresholdsSchema>;
/** One alert's validated window, critical value, and priority. */
export type AlertThreshold = AlertThresholds[AlertId];

export const DatadogMonitorSchema = z
  .object({
    id: AlertIdSchema,
    name: z.string().min(1),
    type: z.enum(["metric alert", "log alert"]),
    query: z.string().min(1),
    message: z.string().min(1),
    tags: z.array(z.string().min(1)).min(1),
    priority: z.number().int().min(1).max(5),
    threshold_key: AlertIdSchema,
    runbook: z.string().regex(/^docs\/runbooks\/[a-z0-9-]+\.md#[a-z0-9-]+$/u),
    options: z
      .object({
        thresholds: z
          .object({ critical: z.number(), warning: z.number().optional() })
          .strict(),
      })
      .strict(),
  })
  .strict();

/** Validated monitor fields used by the repository's Datadog subset. */
export type DatadogMonitor = z.infer<typeof DatadogMonitorSchema>;

export const DatadogMonitorsSchema = z.array(DatadogMonitorSchema).min(1);
