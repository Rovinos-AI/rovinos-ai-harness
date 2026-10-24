// SPDX-License-Identifier: Apache-2.0
import { RunConsoleListSchema } from "@rovinos/schemas/browser";

const listTool = "harness.runs.list";
export const runsConsolePageSize = 20;

interface ToolResult {
  readonly isError?: boolean | undefined;
  readonly structuredContent?: unknown;
}

interface RunListBridge {
  callTool(name: typeof listTool, args: Record<string, unknown>): Promise<ToolResult>;
}

/** Returns the structured list content or rejects failed tool responses. */
export function runsConsoleResultValue(result: ToolResult): unknown {
  if (result.isError === true || result.structuredContent === undefined) {
    throw new Error("runs_console_tool_failed");
  }
  return result.structuredContent;
}

/** Finds the next non-empty run page while guarding against stale filters and cursor loops. */
export async function nextVisibleRunPage(
  bridge: RunListBridge,
  requestedFilter: string | undefined,
  firstCursor: string,
  filterIsCurrent: () => boolean,
): Promise<ReturnType<typeof RunConsoleListSchema.parse> | undefined> {
  let cursor = firstCursor;
  const seenCursors = new Set<string>();
  while (!seenCursors.has(cursor)) {
    seenCursors.add(cursor);
    const response = await bridge.callTool(listTool, {
      limit: runsConsolePageSize,
      cursor,
      ...(requestedFilter === undefined ? {} : { status: requestedFilter }),
    });
    const page = RunConsoleListSchema.parse(runsConsoleResultValue(response));
    if (!filterIsCurrent()) {
      return undefined;
    }
    if (page.runs.length > 0) {
      return {
        runs: page.runs,
        ...(page.nextCursor === undefined || seenCursors.has(page.nextCursor)
          ? {}
          : { nextCursor: page.nextCursor }),
      };
    }
    if (page.nextCursor === undefined || seenCursors.has(page.nextCursor)) {
      return { runs: [] };
    }
    cursor = page.nextCursor;
  }
  return { runs: [] };
}
