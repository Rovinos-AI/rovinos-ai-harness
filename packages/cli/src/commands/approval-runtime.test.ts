// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { HarnessConfigSchema } from "@rovinos/config";
import { createRuntime as createCoreRuntime, type Runtime } from "@rovinos/core";
import type { RunQueue } from "@rovinos/store";
import { InMemoryEventStore } from "@rovinos/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliContext } from "../command.js";
import { createOutput } from "../output.js";
import { withApprovalRuntime } from "./approval-runtime.js";

const temporaryDirectories: string[] = [];

async function createRuntimeFixture(): Promise<{ runtime: Runtime; close: Runtime["close"] }> {
  const runtime = await createCoreRuntime(HarnessConfigSchema.parse({}), {
    store: new InMemoryEventStore(),
    transientVault: true,
  });
  const close = vi.spyOn(runtime, "close");
  return { runtime, close };
}

function queue(close: RunQueue["close"]): RunQueue {
  const unused = (): never => {
    throw new Error("The queue method is not used by this test.");
  };
  return {
    enqueue: unused,
    claim: unused,
    heartbeat: unused,
    complete: unused,
    fail: unused,
    release: unused,
    getDeadLetter: unused,
    close,
  };
}

function context(
  config: ReturnType<typeof HarnessConfigSchema.parse>,
  createRuntime: NonNullable<CliContext["createRuntime"]>,
  overrides: Partial<CliContext> = {},
): CliContext {
  return {
    loadConfig: () => Promise.resolve(config),
    clock: { now: () => 10 },
    out: createOutput({ stdout: vi.fn(), stderr: vi.fn() }),
    createRuntime,
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
    const { runtime, close } = await createRuntimeFixture();
    const closeQueue = vi.fn<RunQueue["close"]>(() => Promise.resolve());
    const runQueue = queue(closeQueue);
    const createRuntime = vi.fn<NonNullable<CliContext["createRuntime"]>>(() => runtime);
    const commandContext = context(configValue, createRuntime, {
      openRunQueue: () => Promise.resolve(runQueue),
    });

    await expect(
      withApprovalRuntime(
        commandContext,
        undefined,
        (receivedRuntime, receivedConfig) => {
          expect(receivedRuntime).toBe(runtime);
          expect(receivedConfig.run.autoResume).toBe(true);
          return Promise.resolve("complete");
        },
        { disableAutoResume: true, useQueue: true },
      ),
    ).resolves.toBe("complete");

    const runtimeArguments = createRuntime.mock.calls[0];
    expect(runtimeArguments?.[0].run.autoResume).toBe(false);
    expect(runtimeArguments?.[1]?.queue).toBe(runQueue);
    expect(close).toHaveBeenCalledOnce();
    expect(closeQueue).toHaveBeenCalledOnce();
  });

  it("closes an acquired queue when runtime construction fails", async () => {
    const configValue = HarnessConfigSchema.parse({});
    const failure = new Error("synthetic runtime construction failure");
    const closeQueue = vi.fn<RunQueue["close"]>(() => Promise.resolve());
    const runQueue = queue(closeQueue);
    const commandContext = context(configValue, () => Promise.reject(failure), {
      openRunQueue: () => Promise.resolve(runQueue),
    });

    await expect(
      withApprovalRuntime(commandContext, undefined, () => Promise.resolve(), { useQueue: true }),
    ).rejects.toBe(failure);
    expect(closeQueue).toHaveBeenCalledOnce();
  });

  it("opens and closes the configured queue when no queue factory is injected", async () => {
    const directory = await mkdtemp(join(process.cwd(), ".tmp", "approval-runtime-"));
    temporaryDirectories.push(directory);
    const configValue = HarnessConfigSchema.parse({});
    const { runtime, close } = await createRuntimeFixture();

    await expect(
      withApprovalRuntime(
        context(configValue, () => runtime, { dataDir: directory }),
        undefined,
        () => Promise.resolve("queued"),
        { useQueue: true },
      ),
    ).resolves.toBe("queued");
    expect(close).toHaveBeenCalledOnce();
  });
});
