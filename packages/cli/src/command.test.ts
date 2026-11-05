// SPDX-License-Identifier: Apache-2.0
import { HarnessConfigSchema } from "@rovinos/config";
import { HarnessError } from "@rovinos/schemas";
import * as evalApi from "@rovinos/eval";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cliPrincipal, createCommandRuntime } from "./command.js";
import { createOutput } from "./output.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("cliPrincipal", () => {
  it("uses the configured CLI principal or the default", () => {
    expect(cliPrincipal(HarnessConfigSchema.parse({ cli: { principal: "cli.operator" } }))).toBe(
      "cli.operator",
    );
    expect(cliPrincipal(HarnessConfigSchema.parse({}))).toBe("cli.local");
  });

  it("injects the credential-free socket model for trial run and resume runtimes", async () => {
    const model = {
      complete: () => Promise.reject(new Error("synthetic_unused")),
    };
    const client = vi.spyOn(evalApi, "createLiveModelClient").mockReturnValue(model);
    const stopped = new Error("synthetic_runtime_stop");
    const createRuntime = vi.fn(() => {
      throw stopped;
    });
    vi.stubEnv("HARNESS_EVAL_MODEL_SOCKET", "/run/harness-model.sock");
    const config = HarnessConfigSchema.parse({});
    await expect(
      createCommandRuntime(
        {
          loadConfig: () => Promise.resolve(config),
          clock: { now: () => 1 },
          out: createOutput({ stdout: () => undefined, stderr: () => undefined }),
          createRuntime,
        },
        config,
      ),
    ).rejects.toBe(stopped);
    expect(client).toHaveBeenCalledExactlyOnceWith("/run/harness-model.sock");
    expect(createRuntime).toHaveBeenCalledExactlyOnceWith(config, { model });
  });

  it("validates names supplied with --as", () => {
    expect(cliPrincipal(HarnessConfigSchema.parse({}), "operator")).toBe("cli.operator");
    expect(cliPrincipal(HarnessConfigSchema.parse({}), "a".repeat(60))).toBe(
      `cli.${"a".repeat(60)}`,
    );
    let error: unknown;
    try {
      cliPrincipal(HarnessConfigSchema.parse({}), "a".repeat(61));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(HarnessError);
    expect(error).toMatchObject({ code: "usage" });
  });
});
