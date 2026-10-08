// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("node:child_process");
  vi.resetModules();
});

it("explains how to start the Compose harness when its container is missing", async () => {
  const execFileSync = vi.fn((): string => "");
  vi.doMock("node:child_process", () => ({ execFileSync }));
  const { readHarnessHealthStatus } = await import("./compose-smoke.js");

  expect(() => readHarnessHealthStatus()).toThrow(
    "harness service is not running; start it with scripts/ci/compose-wait.sh",
  );
  expect(execFileSync).toHaveBeenCalledTimes(1);
});
