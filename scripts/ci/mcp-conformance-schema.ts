// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

/** Frozen protocol revision used by the advisory lanes. */
export const protocolRevision = "2026-07-28";
/** Pinned official conformance runner revision. */
export const runnerRevision = "0.2.0-alpha.12";
/** Owner-approved initial set of measured scenarios for each role. */
export const measuredScenarios = {
  client: ["tools_call"],
  server: ["server-stateless", "tools-list"],
} as const;

const roles = z.enum(["client", "server"]);
const requirementReason = z.enum(["extension", "added-after-release", "pending"]);
/** Parsed frozen inventory from the official runner requirements. */
export const requirementsSchema = z
  .object({
    server: z.array(z.string().min(1)),
    client: z.array(z.string().min(1)),
    not_scored: z.array(
      z
        .object({
          scenario: z.string().min(1),
          leg: roles,
          reason: requirementReason,
          note: z.string().optional(),
        })
        .strict(),
    ),
  })
  .strict();
/** Valid statuses for one measured conformance scenario. */
export const scenarioStatus = z.enum(["passed", "failed", "skipped", "not_measured"]);
/** Runtime contract for one required scenario result. */
export const scenarioReportSchema = z
  .object({
    scenario: z.string().min(1),
    status: scenarioStatus,
    reason: z.string().optional(),
  })
  .strict();
const notScoredReportSchema = z
  .object({
    scenario: z.string().min(1),
    role: roles,
    status: z.literal("not_scored"),
    reason: requirementReason,
    note: z.string().optional(),
  })
  .strict();
const notMeasuredCapabilitySchema = z
  .object({
    capability: z.string().min(1),
    reason: z.string().min(1),
  })
  .strict();
/** Runtime contract for the sanitized advisory report. */
export const conformanceReportSchema = z
  .object({
    runner: z.literal(`@modelcontextprotocol/conformance@${runnerRevision}`),
    protocolRevision: z.literal(protocolRevision),
    advisory: z.literal(true),
    client: z.array(scenarioReportSchema),
    server: z.array(scenarioReportSchema),
    notScored: z.array(notScoredReportSchema),
    notMeasuredCapabilities: z.array(notMeasuredCapabilitySchema),
  })
  .strict();

/** Validated summary of measured, omitted, and not-scored scenarios. */
export type ConformanceReport = z.infer<typeof conformanceReportSchema>;
/** Result of one conformance scenario run. */
export type ConformanceScenarioStatus = z.infer<typeof scenarioStatus>;
