// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { FakeToolPort, FakeToolScriptMissingError } from "./fake-tool.js";

const call = {
  callId: "00000000000000000000000000",
  toolId: "test_tool",
  args: { value: 1 },
};
const context = { runId: call.callId, signal: new AbortController().signal };

describe("FakeToolPort", () => {
  it("describes configured tools and captures executions", async () => {
    const execute = vi.fn().mockResolvedValue({ outcome: "ok", result: "done" });
    const tool = new FakeToolPort(
      new Map([["test_tool", { idempotent: true, timeoutMs: 1000, execute }]]),
    );

    expect(tool.describe(call.toolId)).toEqual({ idempotent: true, timeoutMs: 1000 });
    await expect(tool.execute(call, context)).resolves.toEqual({ outcome: "ok", result: "done" });
    expect(execute).toHaveBeenCalledWith(call, context);
    expect(tool.calls).toEqual([{ call, context }]);
  });

  it("returns undefined for unknown tools and rejects unscripted direct execution", async () => {
    const tool = new FakeToolPort();

    expect(tool.describe(call.toolId)).toBeUndefined();
    await expect(tool.execute(call, context)).rejects.toBeInstanceOf(FakeToolScriptMissingError);
  });
});
