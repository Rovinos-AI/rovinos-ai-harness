// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, it, vi } from "vitest";
import { writeOutput } from "./output.js";

afterEach(() => {
  vi.restoreAllMocks();
});

it("writes output to stdout", () => {
  const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);

  writeOutput("output");

  expect(write).toHaveBeenCalledExactlyOnceWith("output");
});
