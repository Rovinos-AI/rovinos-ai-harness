// SPDX-License-Identifier: Apache-2.0
import { KeysConfigSchema, RunConfigSchema } from "@rovinos/schemas";
import { InMemoryEventStore } from "@rovinos/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntime as createRuntimeImpl } from "./runtime.js";

const config = { run: RunConfigSchema.parse({}) };
const createRuntime = (
  runtimeConfig: Parameters<typeof createRuntimeImpl>[0],
  overrides: Parameters<typeof createRuntimeImpl>[1] = {},
) => createRuntimeImpl(runtimeConfig, { ...overrides, transientVault: true });

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("runtime key setup", () => {
  it("fails production startup when no keys are configured", async () => {
    vi.stubEnv("NODE_ENV", "production");

    await expect(createRuntime(config, { store: new InMemoryEventStore() })).rejects.toMatchObject({
      code: "key_config_required",
    });
  });

  it("warns and exposes a working ephemeral provider in development", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const warnings: string[] = [];
    const runtime = await createRuntime(config, {
      store: new InMemoryEventStore(),
      onKeysWarning: (code) => warnings.push(code),
    });
    const key = await runtime.keys.getKey(runtime.keys.currentKeyId());

    expect(runtime.keys.currentKeyId()).toBe("ephemeral");
    expect(key).toHaveLength(32);
    expect(warnings).toEqual(["keys_ephemeral"]);

    await runtime.close();
    expect(key).toEqual(new Uint8Array(32));
  });

  it("resolves the current key during startup and rejects an invalid length", async () => {
    const runtimeConfig = {
      ...config,
      keys: KeysConfigSchema.parse({
        currentKeyId: "primary",
        keys: [{ id: "primary", secret: "env:PRIMARY_KEY" }],
      }),
    };

    await expect(
      createRuntime(runtimeConfig, {
        store: new InMemoryEventStore(),
        secretResolver: {
          resolve: () => Promise.resolve({ reveal: () => Buffer.alloc(31).toString("base64") }),
        },
      }),
    ).rejects.toMatchObject({ code: "key_invalid_length" });
  });
});
