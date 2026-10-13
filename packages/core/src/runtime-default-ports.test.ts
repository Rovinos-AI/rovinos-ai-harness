// SPDX-License-Identifier: Apache-2.0
import { Code, Id, ModelRequestSchema } from "@harness/schemas";
import { describe, expect, it } from "vitest";
import { missingModelPort, unavailableTool } from "./runtime-default-ports.js";

const context = {
  runId: Id.parse("00000000000000000000000000"),
  signal: new AbortController().signal,
};

describe("runtime default ports", () => {
  it("raises the safe model error when no model port is configured", async () => {
    const request = ModelRequestSchema.parse({
      requestId: "00000000000000000000000001",
      model: { provider: "test", model: "test" },
      messages: [],
    });

    await expect(missingModelPort.complete(request, context)).rejects.toMatchObject({
      code: "model_not_configured",
    });
  });

  it("raises the safe tool error when no tool port is configured", async () => {
    expect(unavailableTool.describe(Code.parse("test_tool"))).toBeUndefined();
    await expect(
      unavailableTool.execute(
        {
          callId: Id.parse("00000000000000000000000001"),
          toolId: Code.parse("test_tool"),
          args: {},
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "tool_not_configured" });
  });
});
