// SPDX-License-Identifier: Apache-2.0
import { Command } from "commander";
import { describe, expect, it } from "vitest";
import {
  createDefaultContext,
  createOutput,
  ExitCode,
  main,
  type CliContext,
} from "./programmatic.js";

describe("programmatic CLI exports", () => {
  it("exposes the public invocation, context, output, and exit-code APIs", () => {
    const output = createOutput({ stdout: () => undefined, stderr: () => undefined });
    const context: CliContext = createDefaultContext(new Command(), output);

    expect(main).toBeTypeOf("function");
    expect(context.out).toBe(output);
    expect(ExitCode.ok).toBe(0);
  });
});
