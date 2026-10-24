// SPDX-License-Identifier: Apache-2.0
import { Code, Id } from "@rovinos/schemas";
import type { EventStore } from "@rovinos/store";
import {
  ResourceNotFoundError,
  ResourceTemplate,
  type McpServer,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { requireControlPlaneScope, type ControlPlaneAuditHandler } from "../auth.js";
import { getRun } from "../tools/get-run.js";
import { listRuns } from "../tools/list-runs.js";

/** URI for the current metadata-only run list. */
export const RUNS_RESOURCE_URI = "harness://runs";
/** URI template for one metadata-only run view. */
export const RUN_RESOURCE_URI_TEMPLATE = "harness://runs/{runId}";
const RUNS_RESOURCE_TOOL = Code.parse("harness.runs.resource");
const JSON_MIME_TYPE = "application/json";

/** Registers metadata-only run-list and single-run MCP resources. */
export function registerRunResources(
  server: McpServer,
  store: EventStore,
  audit?: ControlPlaneAuditHandler,
): void {
  server.registerResource(
    "harness-runs",
    RUNS_RESOURCE_URI,
    { title: "Harness runs", mimeType: JSON_MIME_TYPE },
    async (uri, context) => {
      const principal = requireControlPlaneScope(context, RUNS_RESOURCE_TOOL, "read", audit);
      const output = await listRuns(store, { limit: 50 }, principal?.runIds);
      return {
        contents: [{ uri: uri.href, mimeType: JSON_MIME_TYPE, text: JSON.stringify(output) }],
      };
    },
  );
  server.registerResource(
    "harness-run",
    new ResourceTemplate(RUN_RESOURCE_URI_TEMPLATE, { list: undefined }),
    { title: "Harness run", mimeType: JSON_MIME_TYPE },
    async (uri, variables, context) => {
      const parsedRunId = Id.safeParse(variables.runId);
      if (!parsedRunId.success) {
        throw new ResourceNotFoundError(uri.href);
      }
      authorizeRunRead(context, parsedRunId.data, audit);
      const output = await getRun(store, { runId: parsedRunId.data });
      if (output === undefined) {
        throw new ResourceNotFoundError(uri.href);
      }
      return {
        contents: [{ uri: uri.href, mimeType: JSON_MIME_TYPE, text: JSON.stringify(output) }],
      };
    },
  );
}

function authorizeRunRead(
  context: ServerContext,
  runId: ReturnType<typeof Id.parse>,
  audit: ControlPlaneAuditHandler | undefined,
): void {
  const principal = requireControlPlaneScope(context, RUNS_RESOURCE_TOOL, "read", audit);
  if (principal?.runIds !== undefined && !principal.runIds.includes(runId)) {
    throw new ResourceNotFoundError(`${RUNS_RESOURCE_URI}/${runId}`);
  }
}
