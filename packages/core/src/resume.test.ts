// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { RunNotResumableError } from "./resume.js";

describe("resume errors", () => {
  it("exposes a stable code when a run cannot be resumed", () => {
    expect(new RunNotResumableError()).toMatchObject({
      name: "RunNotResumableError",
      code: "run_not_resumable",
    });
  });
});
