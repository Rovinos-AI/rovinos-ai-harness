// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { normalizeWorkerError } from "./conformance-concurrency.js";

describe("normalizeWorkerError", () => {
  it("preserves a non-Error worker failure as the rejection cause", async () => {
    const cause = { code: "worker_failure" };

    await expect(Promise.reject(normalizeWorkerError(cause))).rejects.toMatchObject({
      message: "Concurrency worker error",
      cause,
    });
  });
});
