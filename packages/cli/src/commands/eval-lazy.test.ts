// SPDX-License-Identifier: Apache-2.0
import { HarnessConfigSchema } from "@rovinos/config";
import { afterEach, expect, it, vi } from "vitest";
import type * as EvalApi from "@rovinos/eval";
import type { CliContext } from "../command.js";
import { createOutput } from "../output.js";

afterEach(() => {
  vi.doUnmock("@rovinos/eval");
  vi.resetModules();
});

it("loads the eval package only when the eval command runs", async () => {
  vi.resetModules();
  const loaded: boolean[] = [];
  vi.doMock("@rovinos/eval", async () => {
    loaded.push(true);
    return vi.importActual<typeof EvalApi>("@rovinos/eval");
  });

  const { evalCommand } = await import("./eval.js");
  expect(loaded).toEqual([]);

  const stderr: string[] = [];
  const context: CliContext = {
    loadConfig: () => Promise.resolve(HarnessConfigSchema.parse({})),
    out: createOutput({ stdout: () => undefined, stderr: (text) => stderr.push(text) }),
    clock: { now: () => 1_234 },
  };
  const { main } = await import("../main.js");
  await main(["eval", "run", "/missing/suite.json"], context, [evalCommand]);

  expect(loaded).toEqual([true]);
  expect(stderr).toHaveLength(1);
});
