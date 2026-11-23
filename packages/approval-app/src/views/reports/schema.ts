// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

const Code = z.string().regex(/^[a-z0-9_.-]{1,64}$/u);

const metricSummarySchema = z
  .object({
    mean: z.number().nonnegative(),
    median: z.number().nonnegative(),
    p95: z.number().nonnegative(),
  })
  .strip();

const evalReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    invariantsEnabled: z.boolean(),
    trials: z.array(
      z
        .object({
          taskId: Code,
          variantId: Code,
          passed: z.boolean(),
          graders: z.array(
            z
              .object({
                graderId: Code,
                pass: z.boolean(),
                codes: z.array(Code),
              })
              .strip(),
          ),
        })
        .strip(),
    ),
    aggregates: z.array(
      z
        .object({
          taskId: Code,
          variantId: Code,
          n: z.number().int().nonnegative(),
          passes: z.number().int().nonnegative(),
          passRate: z.number().min(0).max(1),
          standardError: z.number().nonnegative(),
          passAtK: z.array(
            z
              .object({ k: z.number().int().positive(), rate: z.number().min(0).max(1) })
              .strip(),
          ),
          costMicros: metricSummarySchema,
          steps: metricSummarySchema,
          latencyMs: metricSummarySchema,
        })
        .strip(),
    ),
  })
  .strip();

const comparisonReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    comparisons: z.array(
      z
        .object({
          scope: z.enum(["task", "overall"]),
          taskId: Code.optional(),
          variantA: Code,
          variantB: Code,
          metrics: z.array(
            z
              .object({
                metric: z.enum(["pass_rate", "cost_micros", "steps", "latency_ms"]),
                a: z.number(),
                b: z.number(),
                verdict: z.enum(["better", "worse", "inconclusive"]),
                adjustedPValue: z.number().min(0).max(1).nullable(),
                confidenceInterval: z
                  .object({ low: z.number(), high: z.number() })
                  .strip()
                  .nullable(),
              })
              .strip(),
          ),
        })
        .strip(),
    ),
  })
  .strip();

const replayReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    summary: z
      .object({
        added: z.number().int().nonnegative(),
        behavioral: z.number().int().nonnegative(),
        changed: z.number().int().nonnegative(),
        noise: z.number().int().nonnegative(),
        removed: z.number().int().nonnegative(),
      })
      .strip(),
    entries: z.array(
      z
        .object({
          class: z.enum(["behavioral", "noise"]),
          eventKind: Code,
          index: z.number().int().nonnegative(),
          kind: z.enum(["added", "removed", "changed"]),
          fields: z
            .array(
              z
                .object({
                  field: Code,
                  a: z.union([z.string(), z.number(), z.boolean()]),
                  b: z.union([z.string(), z.number(), z.boolean()]),
                })
                .strip(),
            )
            .optional(),
        })
        .strip(),
    ),
  })
  .strip();

/** Report payload subset rendered by the browser-safe reports view. */
export const reportsViewResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("eval"), report: evalReportSchema }).strip(),
  z.object({ kind: z.literal("compare"), report: comparisonReportSchema }).strip(),
  z.object({ kind: z.literal("replay"), report: replayReportSchema }).strip(),
]);
/** Inferred report payload rendered by the browser reports view. */
export type ReportsViewResult = z.infer<typeof reportsViewResultSchema>;

/** Validated tool input used to display the reports view loading state. */
export const reportsViewInputSchema = z
  .object({
    kind: z.enum(["eval", "compare", "replay"]),
    path: z.string().min(1).max(4_096),
  })
  .strip();
