// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { Code } from "../primitives.js";

/** Safe diagnostics for one configured MCP server. */
export const ServersCheckServerResultSchema = z
  .object({
    id: Code,
    transportKind: z.enum(["stdio", "http"]),
    protocolEra: z.enum(["legacy", "modern", "unknown"]),
    protocolVersion: z.iso.date().or(z.literal("unknown")),
    supportsApps: z.boolean(),
    trust: z.enum(["internal", "external"]),
    connectLatencyMs: z.number().int().nonnegative(),
    reachable: z.boolean(),
    toolCount: z.number().int().nonnegative(),
    registeredToolIds: z.array(Code),
    rejectedTools: z.array(z.object({ reason: Code }).strict()),
    tracePropagation: z.enum(["yes", "no"]),
    tracePropagationReason: z.enum(["external", "disabled", "enabled"]),
    warnings: z.array(Code),
    errorCode: Code.optional(),
  })
  .strict();

/** Schema-validated result emitted by `harness servers check`. */
export const ServersCheckResultSchema = z
  .object({
    servers: z.array(ServersCheckServerResultSchema),
    errorCode: Code.optional(),
  })
  .strict();

/** Safe diagnostic metadata for one MCP server. */
export type ServersCheckServerResult = z.infer<typeof ServersCheckServerResultSchema>;
/** Validated result emitted by the `harness servers check` command. */
export type ServersCheckResult = z.infer<typeof ServersCheckResultSchema>;
