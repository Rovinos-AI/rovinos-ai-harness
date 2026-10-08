// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { writeOutput } from "./output.js";

vi.mock("@harness/schemas", () => ({ HARNESS_VERSION: "1.2.3" }));
vi.mock("./output.js", () => ({ writeOutput: vi.fn() }));

const originalArgv = process.argv;
const originalExitCode = process.exitCode;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
});

afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

it("prints the schemas version instead of an environment override and exits without a timer", async () => {
  process.argv = ["node", "bin.js", "--version"];
  vi.stubEnv("HARNESS_VERSION", "9.9.9");

  await import("./bin.js");

  expect(writeOutput).toHaveBeenCalledExactlyOnceWith("1.2.3\n");
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["SIGTERM", "SIGINT"])("clears the active keep-alive timer on %s", async (signal) => {
  process.argv = ["node", "bin.js"];
  const listeners = vi.spyOn(process, "once").mockReturnValue(process);

  await import("./bin.js");
  vi.advanceTimersByTime(120_000);

  expect(writeOutput).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(1);
  const shutdown = listeners.mock.calls.find(([event]) => event === signal)?.[1];
  expect(shutdown).toBeDefined();
  shutdown?.();

  expect(vi.getTimerCount()).toBe(0);
  expect(process.exitCode).toBe(0);
});
