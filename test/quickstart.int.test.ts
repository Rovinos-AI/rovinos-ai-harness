// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "vitest";
import { runQuickstartDocTests } from "../scripts/docs/run-doc-tests.js";

it(
  "executes every runnable command in the quickstart documentation",
  async () => {
    await expect(runQuickstartDocTests()).resolves.toBeUndefined();
  },
  30 * 60_000,
);
