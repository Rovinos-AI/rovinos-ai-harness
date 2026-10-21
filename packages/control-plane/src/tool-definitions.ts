// SPDX-License-Identifier: Apache-2.0
import {
  type ControlPlaneAuthScope,
  JsonValue,
  ResolveRequest,
  ResolveResponse,
  RevealRequest,
  RevealResponse,
} from "@harness/schemas";
import type { Tool } from "@modelcontextprotocol/server";
import { z } from "zod";
import { APPROVAL_RESOURCE_URI } from "./resources/approval.js";
import { RUNS_CONSOLE_RESOURCE_URI } from "./resources/runs-console.js";
import {
  approveInputSchema,
  continueRunInputSchema,
  decisionOutputSchema,
  denyInputSchema,
  getRunInputSchema,
  getRunOutputSchema,
  listRunsInputSchema,
  listRunsOutputSchema,
  resumeRunOutputSchema,
  startRunInputSchema,
  startRunOutputSchema,
  runLifecycleInputSchema,
} from "./schemas.js";

/** Returns public MCP tool definitions in the order used by `tools/list`. */
export function toolDefinitions(): Tool[] {
  return [
    ...runToolDefinitions(),
    {
      name: "approve",
      description: "Approve a pending approval without resuming its run.",
      inputSchema: objectInputSchema(approveInputSchema),
      outputSchema: z.toJSONSchema(decisionOutputSchema),
      annotations: { idempotentHint: false, openWorldHint: false },
      _meta: { ui: { visibility: ["app"] } },
    },
    {
      name: "harness.approvals.resolve",
      description: "Resolve a pending approval from its human review view.",
      inputSchema: objectInputSchema(ResolveRequest),
      outputSchema: z.toJSONSchema(ResolveResponse),
      annotations: { openWorldHint: false },
      _meta: { ui: { visibility: ["app"], resourceUri: APPROVAL_RESOURCE_URI } },
    },
    {
      name: "harness.approvals.reveal",
      description: "Reveal selected approval argument values after authorization.",
      inputSchema: objectInputSchema(RevealRequest),
      outputSchema: z.toJSONSchema(RevealResponse),
      annotations: { openWorldHint: false },
      _meta: { ui: { visibility: ["app"], resourceUri: APPROVAL_RESOURCE_URI } },
    },
    {
      name: "deny",
      description: "Deny a pending approval without resuming its run.",
      inputSchema: objectInputSchema(denyInputSchema),
      outputSchema: z.toJSONSchema(decisionOutputSchema),
      annotations: { idempotentHint: true, openWorldHint: false },
      _meta: { ui: { visibility: ["app"] } },
    },
    {
      name: "start_run",
      description: "Start a run and return its metadata.",
      inputSchema: objectInputSchema(startRunInputSchema),
      outputSchema: z.toJSONSchema(startRunOutputSchema),
      annotations: { idempotentHint: false, openWorldHint: false },
    },
    {
      name: "continue_run",
      description: "Start a follow-up run from a completed run.",
      inputSchema: objectInputSchema(continueRunInputSchema),
      outputSchema: z.toJSONSchema(startRunOutputSchema),
      annotations: { idempotentHint: false, openWorldHint: false },
    },
    {
      name: "resume_run",
      description: "Resume a run asynchronously.",
      inputSchema: objectInputSchema(runLifecycleInputSchema),
      outputSchema: z.toJSONSchema(resumeRunOutputSchema),
      annotations: { openWorldHint: false },
    },
    {
      name: "cancel_run",
      description: "Request cancellation of a run.",
      inputSchema: objectInputSchema(runLifecycleInputSchema),
      outputSchema: z.toJSONSchema(decisionOutputSchema),
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
  ];
}

function runToolDefinitions(): Tool[] {
  return [
    {
      name: "list_runs",
      description: "List run status and metadata counts.",
      inputSchema: objectInputSchema(listRunsInputSchema),
      outputSchema: z.toJSONSchema(listRunsOutputSchema),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      _meta: { ui: { resourceUri: RUNS_CONSOLE_RESOURCE_URI } },
    },
    {
      name: "get_run",
      description: "Get run status, usage, approvals, and recent safe event metadata.",
      inputSchema: objectInputSchema(getRunInputSchema),
      outputSchema: z.toJSONSchema(getRunOutputSchema),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "harness.runs.list",
      description: "List run status and metadata counts for the runs console.",
      inputSchema: objectInputSchema(listRunsInputSchema),
      outputSchema: z.toJSONSchema(listRunsOutputSchema),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      _meta: { ui: { visibility: ["app"], resourceUri: RUNS_CONSOLE_RESOURCE_URI } },
    },
    {
      name: "harness.runs.get",
      description: "Get run metadata for the runs console detail panel.",
      inputSchema: objectInputSchema(getRunInputSchema),
      outputSchema: z.toJSONSchema(getRunOutputSchema),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      _meta: { ui: { visibility: ["app"], resourceUri: RUNS_CONSOLE_RESOURCE_URI } },
    },
  ];
}

/** Returns the authorization scope required by a control-plane tool. */
export function toolScope(name: string): ControlPlaneAuthScope {
  if (
    name === "list_runs" ||
    name === "get_run" ||
    name === "harness.runs.list" ||
    name === "harness.runs.get"
  ) {
    return "read";
  }
  if (name === "approve" || name === "deny" || name === "harness.approvals.resolve") {
    return "approve";
  }
  if (name === "harness.approvals.reveal") {
    return "reveal";
  }
  return "run";
}

function objectInputSchema(schema: z.ZodType): Tool["inputSchema"] {
  return z
    .object({
      type: z.literal("object"),
      properties: z.record(z.string(), JsonValue).optional(),
      required: z.array(z.string()).optional(),
    })
    .loose()
    .parse(z.toJSONSchema(schema));
}
