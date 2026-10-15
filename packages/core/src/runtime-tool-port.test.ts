// SPDX-License-Identifier: Apache-2.0
import { Code, Id, JsonValue } from "@harness/schemas";
import { composeToolPorts } from "./runtime-tool-port.js";
import { describe, expect, it, vi } from "vitest";

const webFetchId = Code.parse("web.fetch");
const existingId = Code.parse("sandbox.probe");
const call = {
  callId: Id.parse("11111111111111111111111121"),
  toolId: webFetchId,
  args: JsonValue.parse({}),
};
const context = {
  runId: Id.parse("11111111111111111111111122"),
  signal: new AbortController().signal,
};

function toolPort(toolId: Code) {
  return {
    describe: (candidate) =>
      candidate === toolId ? { idempotent: true, timeoutMs: 1_000 } : undefined,
    getToolSpecs: () => [{ toolId, description: toolId, inputSchema: {} }],
    execute: vi.fn(() => Promise.resolve({ outcome: "ok" as const, result: null })),
  };
}

describe("composeToolPorts", () => {
  it("advertises unique specs and routes describe and execute to the matching port", async () => {
    const additional = toolPort(webFetchId);
    const existing = toolPort(existingId);
    const collision = { ...toolPort(webFetchId), execute: vi.fn() };
    const composed = composeToolPorts(additional, {
      ...existing,
      getToolSpecs: () => [
        ...(existing.getToolSpecs?.() ?? []),
        ...(collision.getToolSpecs?.() ?? []),
      ],
    });

    expect(composed.getToolSpecs?.().map(({ toolId }) => toolId)).toEqual([webFetchId, existingId]);
    expect(composed.describe(webFetchId)).toEqual(additional.describe(webFetchId));
    await composed.execute(call, context);
    await composed.execute({ ...call, toolId: existingId }, context);

    expect(additional.execute.mock.calls).toHaveLength(1);
    expect(existing.execute.mock.calls).toHaveLength(1);
    expect(composed.describe(Code.parse("unknown.tool"))).toBeUndefined();
  });

  it("forwards preparation and schema validation to the port owning each tool", async () => {
    const additional = {
      ...toolPort(webFetchId),
      prepare: vi.fn((preparedCall) => Promise.resolve(preparedCall)),
      validateInputSchema: vi.fn(() => Promise.resolve(false)),
    };
    const composed = composeToolPorts(additional, toolPort(existingId));

    await expect(composed.prepare?.(call, context)).resolves.toEqual(call);
    await expect(composed.validateInputSchema?.(webFetchId, call.args, {}, context)).resolves.toBe(
      false,
    );
    await expect(composed.validateInputSchema?.(existingId, call.args, {}, context)).resolves.toBe(
      true,
    );

    expect(additional.prepare).toHaveBeenCalledOnce();
    expect(additional.validateInputSchema).toHaveBeenCalledOnce();
  });
});
