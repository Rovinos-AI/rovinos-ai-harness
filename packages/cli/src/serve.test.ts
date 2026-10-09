// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliContext } from "./command.js";
import { ExitCode } from "./exit-codes.js";
import { createOutput } from "./output.js";
import { main } from "./main.js";
import { serveCommand } from "./serve.js";

const context: CliContext = {
  loadConfig: () => Promise.reject(new Error("Configuration not needed in this test.")),
  out: createOutput({ stdout: () => undefined, stderr: () => undefined }),
  clock: { now: () => 1_000 },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("serve command", () => {
  it.each(["SIGINT", "SIGTERM"] as const)("stops cleanly on %s", async (signal) => {
    const sigintListeners = process.listenerCount("SIGINT");
    const sigtermListeners = process.listenerCount("SIGTERM");
    const result = main(["serve"], context, [serveCommand]);

    await vi.waitFor(() => {
      expect(process.listenerCount(signal)).toBe(
        signal === "SIGINT" ? sigintListeners + 1 : sigtermListeners + 1,
      );
    });
    process.emit(signal);

    await expect(result).resolves.toBe(ExitCode.ok);
    expect(process.listenerCount("SIGINT")).toBe(sigintListeners);
    expect(process.listenerCount("SIGTERM")).toBe(sigtermListeners);
  });
});
