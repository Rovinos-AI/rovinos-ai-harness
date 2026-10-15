// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "vitest";
import { runInspectorConformance } from "../scripts/ci/inspector-conformance.js";

it("conforms harness serve with the MCP Inspector CLI", async () => {
  await expect(runInspectorConformance()).resolves.toBeUndefined();
}, 180_000);
