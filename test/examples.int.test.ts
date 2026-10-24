// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "vitest";
import { runExampleDocTests } from "../scripts/docs/run-doc-tests.js";

it(
  "executes every runnable command in the copy-paste example READMEs",
  async () => {
    await expect(runExampleDocTests()).resolves.toBeUndefined();
  },
  45 * 60_000,
);
