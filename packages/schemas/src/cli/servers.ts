// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { Code, Sha256Hex } from "../primitives.js";

/** Safe diagnostics for one configured MCP server. */
export const ServersCheckPhaseStatusSchema = z.enum([
  "success",
  "partial",
  "failed",
  "not_tested",
  "not_applicable",
]);

/** Safe status for one independently observable servers-check phase. */
export const ServersCheckPhaseSchema = z
  .object({
    status: ServersCheckPhaseStatusSchema,
    errorCode: Code.optional(),
  })
  .strict();

/** Status of the diagnostic phases that do not invoke tools. */
export const ServersCheckPhasesSchema = z
  .object({
    connection: ServersCheckPhaseSchema,
    authentication: ServersCheckPhaseSchema,
    negotiation: ServersCheckPhaseSchema,
    discovery: ServersCheckPhaseSchema,
    schemaValidation: ServersCheckPhaseSchema,
    exposure: ServersCheckPhaseSchema,
    policyConfiguration: z
      .object({
        status: z.literal("not_tested"),
        allowlistConfigured: z.boolean(),
      })
      .strict(),
  })
  .strict();

/** Safe diagnostics for one configured MCP server. */
export const ServersCheckServerResultSchema = z
  .object({
    id: Code,
    transportKind: z.enum(["stdio", "http"]),
    protocolEra: z.enum(["legacy", "modern", "unknown"]),
    protocolVersion: z.iso.date().or(z.literal("unknown")),
    supportsApps: z.boolean(),
    capabilities: z
      .object({
        apps: z.enum(["yes", "no", "unknown"]),
        tools: z.enum(["yes", "no", "unknown"]),
      })
      .strict(),
    trust: z.enum(["internal", "external"]),
    connectLatencyMs: z.number().int().nonnegative(),
    reachable: z.boolean(),
    toolCount: z.number().int().nonnegative(),
    acceptedToolCount: z.number().int().nonnegative(),
    excludedToolCount: z.number().int().nonnegative(),
    registeredToolIds: z.array(Code),
    rejectedTools: z.array(z.object({ reason: Code }).strict()),
    phases: ServersCheckPhasesSchema,
    aliasMappingAvailable: z.boolean(),
    nextAction: z.enum([
      "none",
      "configure_authentication",
      "check_transport_configuration",
      "retry_discovery",
      "review_server_configuration",
      "review_tool_configuration",
      "review_tool_allowlist",
    ]),
    tracePropagation: z.enum(["yes", "no"]),
    tracePropagationReason: z.enum(["external", "disabled", "enabled"]),
    warnings: z.array(Code),
    errorCode: Code.optional(),
  })
  .strict()
  .superRefine((server, context) => {
    if (server.acceptedToolCount !== server.registeredToolIds.length) {
      context.addIssue({ code: "custom", path: ["acceptedToolCount"] });
    }
    if (server.acceptedToolCount + server.excludedToolCount !== server.toolCount) {
      context.addIssue({ code: "custom", path: ["excludedToolCount"] });
    }
  });

/** Versioned, schema-validated report emitted by `harness servers check`. */
export const ServersCheckResultSchema = z
  .object({
    reportVersion: z.literal(1),
    catalogFingerprint: Sha256Hex.optional(),
    catalogFingerprintStatus: z.enum(["complete", "partial", "not_tested"]),
    servers: z.array(ServersCheckServerResultSchema),
    errorCode: Code.optional(),
  })
  .strict()
  .superRefine((result, context) => {
    if (
      (result.catalogFingerprintStatus === "complete") !==
      (result.catalogFingerprint !== undefined)
    ) {
      context.addIssue({ code: "custom", path: ["catalogFingerprint"] });
    }
  });

/** Safe diagnostic metadata for one MCP server. */
export type ServersCheckServerResult = z.infer<typeof ServersCheckServerResultSchema>;
/** Safe status for one independently observable servers-check phase. */
export type ServersCheckPhase = z.infer<typeof ServersCheckPhaseSchema>;
/** Status of all diagnostic phases for one server. */
export type ServersCheckPhases = z.infer<typeof ServersCheckPhasesSchema>;
/** Validated result emitted by the `harness servers check` command. */
export type ServersCheckResult = z.infer<typeof ServersCheckResultSchema>;
