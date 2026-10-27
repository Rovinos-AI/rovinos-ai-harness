// SPDX-License-Identifier: Apache-2.0
import { HarnessConfigSchema } from "@rovinos/config";
import { describe, expect, it, vi } from "vitest";
import type { CliContext } from "../command.js";
import { createOutput } from "../output.js";
import { createLoginKeys } from "./servers-auth.js";

describe("server OAuth key setup", () => {
  it("resolves and disposes the configured OAuth key", async () => {
    const config = HarnessConfigSchema.parse({
      keys: { currentKeyId: "test_key", keys: [{ id: "test_key", secret: "env:TEST_KEY" }] },
    });
    const context: CliContext = {
      loadConfig: () => Promise.resolve(config),
      clock: { now: () => 1 },
      out: createOutput({ stdout: vi.fn(), stderr: vi.fn() }),
      secretResolver: {
        resolve: () => Promise.resolve({ reveal: () => Buffer.alloc(32, 7).toString("base64") }),
      },
    };
    const keys = createLoginKeys(config, context);

    expect(keys.currentKeyId()).toBe("test_key");
    expect(await keys.getKey("test_key")).toHaveLength(32);
    keys.dispose();
  });
});
