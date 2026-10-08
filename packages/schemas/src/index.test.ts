// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "vitest";
import { HARNESS_VERSION } from "./index.js";

test("exports the harness version", () => {
  expect(HARNESS_VERSION).toBe("0.0.0");
});
