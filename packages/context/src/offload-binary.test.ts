// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { SequentialIdGenerator, type JsonValue } from "@harness/schemas";
import { InMemoryWorkspace, OffloadedStub, OffloadingToolPort } from "./offload.js";

const runId = "00000000000000000000000001";
const context = { runId, signal: new AbortController().signal };
const call = { callId: runId, toolId: "binary.tool", args: null };

function fixture(result: JsonValue) {
  const workspace = new InMemoryWorkspace();
  const write = vi.spyOn(workspace, "write");
  const port = new OffloadingToolPort(
    {
      describe: () => ({ idempotent: true, timeoutMs: 1000 }),
      execute: () => Promise.resolve({ outcome: "ok", binary: true, result }),
    },
    workspace,
    { thresholdBytes: 10000000 },
    new SequentialIdGenerator(),
  );
  return { port, workspace, write };
}

describe("binary offloading", () => {
  it("always offloads validated bytes without previews, even below the threshold", async () => {
    const { port, workspace, write } = fixture([0, 255]);
    const execution = await port.execute(call, context);
    const stub = OffloadedStub.parse(execution.result);
    expect(stub.$offloaded.preview).toBe("");
    expect(write).toHaveBeenCalledTimes(1);
    expect(execution.binary).toBeUndefined();
    expect(
      new TextDecoder().decode(
        await workspace.read(`.harness/offload/${stub.$offloaded.handle}.json`),
      ),
    ).toBe("[0,255]");
  });

  it.each(["synthetic@example.test", [256], { data: [1] }])(
    "rejects unvalidated binary before workspace persistence %#",
    async (result) => {
      const { port, write } = fixture(result);
      await expect(port.execute(call, context)).resolves.toEqual({
        outcome: "error",
        errorCode: "pii_input_invalid",
        result: null,
      });
      expect(write).not.toHaveBeenCalled();
    },
  );
});
