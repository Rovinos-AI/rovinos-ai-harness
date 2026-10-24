// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "vitest";
import { runReplayExampleDocTests } from "../scripts/docs/run-doc-tests.js";

it(
  "executes the replay-from-trace README command and checks its canary assertion",
  async () => {
    await expect(runReplayExampleDocTests()).resolves.toBeUndefined();
  },
  30 * 60_000,
);
