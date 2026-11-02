// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "vitest";
import { runEvalTutorialDocTests } from "../scripts/docs/run-doc-tests.js";

it(
  "executes the eval tutorial replay and comparison commands",
  async () => {
    await expect(runEvalTutorialDocTests()).resolves.toBeUndefined();
  },
  30 * 60_000,
);
