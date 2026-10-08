// SPDX-License-Identifier: Apache-2.0
import { readHarnessHealthStatus } from "../scripts/ci/compose-smoke.js";
import { expect, it } from "vitest";

it("starts the harness service healthy in Compose", () => {
  expect(readHarnessHealthStatus()).toBe("healthy");
});
