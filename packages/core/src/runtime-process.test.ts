// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultProcessLike, RunInputMissingError } from "./runtime-process.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runtime process adapter", () => {
  it("registers and removes signal listeners and manages exit codes", () => {
    const listener = () => undefined;
    defaultProcessLike.on("SIGINT", listener);
    expect(process.listeners("SIGINT")).toContain(listener);
    defaultProcessLike.removeListener("SIGINT", listener);
    expect(process.listeners("SIGINT")).not.toContain(listener);

    const originalExitCode = process.exitCode;
    defaultProcessLike.exitCode = 23;
    expect(defaultProcessLike.exitCode).toBe(23);
    defaultProcessLike.exitCode = undefined;
    expect(defaultProcessLike.exitCode).toBe(23);
    process.exitCode = originalExitCode;
  });

  it("delegates forced termination and exposes the missing-input error code", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit intercepted");
    });

    expect(() => {
      defaultProcessLike.exit(1);
    }).toThrow("exit intercepted");
    expect(exit).toHaveBeenCalledWith(1);
    expect(new RunInputMissingError()).toMatchObject({ code: "run_input_missing" });
  });
});
