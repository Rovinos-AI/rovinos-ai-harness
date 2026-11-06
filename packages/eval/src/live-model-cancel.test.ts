// SPDX-License-Identifier: Apache-2.0
import { stat } from "node:fs/promises";
import { expect, it } from "vitest";
import { z } from "zod";
import { liveModelFailure } from "./live-model-contract.js";
import { createLiveModelClient, startLiveModelGateway } from "./live-model-gateway.js";

it("cancels both sides of a pending trial validation exchange and cleans up the socket", async () => {
  const schema = z.object({ result: z.string() });
  let started: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let finished: (() => void) | undefined;
  const stopped = new Promise<void>((resolve) => {
    finished = resolve;
  });
  let hostCode: string | undefined;
  const gateway = await startLiveModelGateway({
    complete: async (_input, context) => {
      try {
        await context.valueTransform?.(schema, { result: "<EMAIL_1>" });
        throw new Error("expected_cancellation");
      } catch (error) {
        hostCode = liveModelFailure(error);
        throw error;
      } finally {
        finished?.();
      }
    },
  });
  try {
    const controller = new AbortController();
    const pending = createLiveModelClient(gateway.socketPath).complete(
      {
        requestId: "00000000000000000000000001",
        model: { provider: "test", model: "test" },
        messages: [],
      },
      {
        runId: "00000000000000000000000000",
        signal: controller.signal,
        outputSchema: schema,
        valueTransform: () => {
          started?.();
          return new Promise<never>(() => undefined);
        },
      },
    );
    await ready;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "eval_live_cancelled" });
    await stopped;
    expect(hostCode).toBe("eval_live_cancelled");
  } finally {
    await gateway.close();
  }
  await expect(stat(gateway.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
});
