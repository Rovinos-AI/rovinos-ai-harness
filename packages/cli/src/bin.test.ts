// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { main } from "./main.js";

vi.mock("./main.js", () => ({ main: vi.fn(() => Promise.resolve(0)) }));

const originalArgv = process.argv;
const originalExitCode = process.exitCode;

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
});

it("passes CLI arguments to main and uses its exit code", async () => {
  process.argv = ["node", "bin.js", "--version"];

  await import("./bin.js");

  expect(main).toHaveBeenCalledExactlyOnceWith(["--version"]);
  expect(process.exitCode).toBe(0);
});
