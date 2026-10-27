// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { HarnessConfigSchema } from "@rovinos/config";
import type { Runtime } from "@rovinos/core";
import type { RunQueue } from "@rovinos/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliContext } from "../command.js";
import { createOutput } from "../output.js";
import { withApprovalRuntime } from "./approval-runtime.js";

const temporaryDirectories: string[] = [];

function fakeRuntime() {
  return {
    close: vi.fn(() => Promise.resolve()),
  } as unknown as Runtime;
}

function context(
  config: ReturnType<typeof HarnessConfigSchema.parse>,
  runtime: Runtime,
  overrides: Partial<CliContext> = {},
): CliContext {
  return {
    loadConfig: () => Promise.resolve(config),
    clock: { now: () => 10 },
    out: createOutput({ stdout: vi.fn(), stderr: vi.fn() }),
    createRuntime: () => runtime,
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("approval command runtime ownership", () => {
  it("applies auto-resume overrides and closes both the runtime and opened queue", async () => {
    const configValue = HarnessConfigSchema.parse({ run: { autoResume: true } });
    const runtime = fakeRuntime();
    const closeQueue = vi.fn(() => Promise.resolve());
    const queue = { close: closeQueue } as unknown as RunQueue;
    const createRuntime = vi.fn((_config: typeof configValue) => runtime);
    const commandContext = context(configValue, runtime, {
      createRuntime,
      openRunQueue: () => Promise.resolve(queue),
    });

    await expect(
      withApprovalRuntime(
        commandContext,
        undefined,
        async (receivedRuntime, receivedConfig) => {
          expect(receivedRuntime).toBe(runtime);
          expect(receivedConfig.run.autoResume).toBe(true);
          return "complete";
        },
        { disableAutoResume: true, useQueue: true },
      ),
    ).resolves.toBe("complete");

    expect(createRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ run: expect.objectContaining({ autoResume: false }) }),
      expect.objectContaining({ queue }),
    );
    expect(runtime.close).toHaveBeenCalledOnce();
    expect(closeQueue).toHaveBeenCalledOnce();
  });

  it("closes an acquired queue when runtime construction fails", async () => {
    const configValue = HarnessConfigSchema.parse({});
    const failure = new Error("synthetic runtime construction failure");
    const closeQueue = vi.fn(() => Promise.resolve());
    const queue = { close: closeQueue } as unknown as RunQueue;
    const commandContext = context(configValue, fakeRuntime(), {
      createRuntime: () => Promise.reject(failure),
      openRunQueue: () => Promise.resolve(queue),
    });

    await expect(
      withApprovalRuntime(commandContext, undefined, async () => undefined, { useQueue: true }),
    ).rejects.toBe(failure);
    expect(closeQueue).toHaveBeenCalledOnce();
  });

  it("opens and closes the configured queue when no queue factory is injected", async () => {
    const directory = await mkdtemp(join(process.cwd(), ".tmp", "approval-runtime-"));
    temporaryDirectories.push(directory);
    const configValue = HarnessConfigSchema.parse({});
    const runtime = fakeRuntime();

    await expect(
      withApprovalRuntime(
        context(configValue, runtime, { dataDir: directory }),
        undefined,
        async () => "queued",
        { useQueue: true },
      ),
    ).resolves.toBe("queued");
    expect(runtime.close).toHaveBeenCalledOnce();
  });
});
