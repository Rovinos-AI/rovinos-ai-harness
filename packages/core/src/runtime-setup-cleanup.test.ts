// SPDX-License-Identifier: Apache-2.0
import { expect, it, vi } from "vitest";
import { closeSetupResources } from "./runtime-setup-cleanup.js";

it("attempts every setup cleanup before rethrowing the first error", async () => {
  const firstError = new Error("synthetic cleanup failure");
  const disposeKeys = vi.fn(() => {
    throw firstError;
  });

  await expect(
    closeSetupResources({
      eventStore: undefined,
      vault: undefined,
      instanceHeartbeat: undefined,
      disposeKeys,
    }),
  ).rejects.toBe(firstError);
  expect(disposeKeys).toHaveBeenCalledOnce();
});
