// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { nextVisibleRunPage, runsConsolePageSize, runsConsoleResultValue } from "./list.js";

describe("runs console pagination", () => {
  it("skips empty pages and returns the next page containing runs", async () => {
    const bridge = {
      callTool: vi
        .fn()
        .mockResolvedValueOnce({ structuredContent: { runs: [], nextCursor: "second" } })
        .mockResolvedValueOnce({
          structuredContent: {
            runs: [
              {
                runId: "00000000000000000000000001",
                status: "completed",
                createdAt: 1,
                lastTs: 2,
                lastSeq: 3,
                steps: 1,
                pendingApprovals: 0,
              },
            ],
            nextCursor: "third",
          },
        }),
    };

    await expect(nextVisibleRunPage(bridge, undefined, "first", () => true)).resolves.toMatchObject(
      {
        runs: [{ status: "completed" }],
        nextCursor: "third",
      },
    );
    expect(bridge.callTool).toHaveBeenNthCalledWith(1, "harness.runs.list", {
      limit: runsConsolePageSize,
      cursor: "first",
    });
    expect(bridge.callTool).toHaveBeenNthCalledWith(2, "harness.runs.list", {
      limit: runsConsolePageSize,
      cursor: "second",
    });
  });

  it("stops when the filter changes and guards repeated cursors", async () => {
    const bridge = {
      callTool: vi.fn().mockResolvedValue({ structuredContent: { runs: [], nextCursor: "first" } }),
    };

    await expect(
      nextVisibleRunPage(bridge, "running", "first", () => false),
    ).resolves.toBeUndefined();
    await expect(nextVisibleRunPage(bridge, undefined, "first", () => true)).resolves.toEqual({
      runs: [],
    });
    expect(bridge.callTool).toHaveBeenCalledTimes(2);
  });

  it("rejects failed or missing list results", () => {
    expect(() => runsConsoleResultValue({ isError: true, structuredContent: {} })).toThrow(
      "runs_console_tool_failed",
    );
    expect(() => runsConsoleResultValue({})).toThrow("runs_console_tool_failed");
  });
});
