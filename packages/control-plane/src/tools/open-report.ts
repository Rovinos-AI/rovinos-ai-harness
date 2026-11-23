// SPDX-License-Identifier: Apache-2.0
import { realpath, readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import { Code, HarnessError, JsonValue, parseJson } from "@rovinos/schemas";
import { z } from "zod";
import type { ControlPlaneAuditHandler } from "../auth.js";
import type { ControlPlaneReportSchemas } from "../server-types.js";
import { withControlPlaneAuthorization } from "../auth.js";
import { REPORTS_RESOURCE_URI } from "../resources/reports.js";

const MAX_REPORT_BYTES = 1_048_576;

/** Validated input for opening a content-free report. */
export const openReportInputSchema = z
  .object({
    kind: z.enum(["eval", "compare", "replay"]),
    path: z.string().min(1).max(4_096),
  })
  .strict();

/** Structured response for an opened report. */
export const openReportOutputSchema = z
  .object({
    kind: z.enum(["eval", "compare", "replay"]),
    report: JsonValue,
  })
  .strict();

/** Inferred input for the `open_report` tool. */
export type OpenReportInput = z.infer<typeof openReportInputSchema>;
/** Inferred report returned by the `open_report` tool. */
export type OpenReportOutput = z.infer<typeof openReportOutputSchema>;

class OpenReportError extends HarnessError {
  override readonly code:
    "report_path_not_allowed" | "report_too_large" | "report_schema_unavailable";

  constructor(code: OpenReportError["code"]) {
    super(code);
    this.code = code;
  }
}

function isWithinDirectory(directory: string, candidate: string): boolean {
  const path = relative(directory, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

async function findReportFile(path: string, reportDirs: readonly string[]): Promise<string> {
  for (const configuredDir of reportDirs) {
    if (!isAbsolute(configuredDir)) {
      continue;
    }
    try {
      const directory = await realpath(configuredDir);
      if (!(await stat(directory)).isDirectory()) {
        continue;
      }
      const candidate = isAbsolute(path) ? resolve(path) : resolve(directory, path);
      const resolved = await realpath(candidate);
      if (!isWithinDirectory(directory, resolved)) {
        continue;
      }
      const file = await stat(resolved);
      if (!file.isFile()) {
        continue;
      }
      if (file.size > MAX_REPORT_BYTES) {
        throw new OpenReportError("report_too_large");
      }
      return resolved;
    } catch (error) {
      if (error instanceof OpenReportError) {
        throw error;
      }
    }
  }
  throw new OpenReportError("report_path_not_allowed");
}

/** Reads and validates a report file that resolves inside a configured report directory. */
export async function openReport(
  reportDirs: readonly string[],
  schemas: ControlPlaneReportSchemas | undefined,
  input: OpenReportInput,
): Promise<OpenReportOutput> {
  const parsedInput = openReportInputSchema.parse(input);
  if (schemas === undefined) {
    throw new OpenReportError("report_schema_unavailable");
  }
  const file = await findReportFile(parsedInput.path, reportDirs);
  const text = await readFile(file, "utf8");
  if (new TextEncoder().encode(text).byteLength > MAX_REPORT_BYTES) {
    throw new OpenReportError("report_too_large");
  }
  const report = parseJson(schemas[parsedInput.kind], text);
  return openReportOutputSchema.parse({ kind: parsedInput.kind, report });
}

/** Registers the read-only `open_report` MCP tool. */
export function registerOpenReportTool(
  server: McpServer,
  reportDirs: readonly string[],
  schemas: ControlPlaneReportSchemas | undefined,
  audit?: ControlPlaneAuditHandler,
): void {
  server.registerTool(
    "open_report",
    {
      description:
        "Open a validated eval, comparison, or replay report from a configured directory.",
      inputSchema: openReportInputSchema,
      outputSchema: openReportOutputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      _meta: { ui: { resourceUri: REPORTS_RESOURCE_URI } },
    },
    async (input, context) =>
      withControlPlaneAuthorization({
        context,
        tool: Code.parse("open_report"),
        scope: "read",
        operation: async () => {
          const output = await openReport(reportDirs, schemas, input);
          return {
            structuredContent: output,
            content: [{ type: "text" as const, text: `${output.kind} report opened.` }],
          };
        },
        audit,
      }),
  );
}
