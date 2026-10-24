// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Id } from "@rovinos/schemas";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Clock } from "../../src/types.js";
import { RunnerLeaseManager } from "./lease.js";
import {
  activateRunWorkspace,
  clearRunScratch,
  lockRunWorkspace,
  sealPersistedRunWorkspaces,
} from "../../src/workspace.js";

const runA = Id.parse("00000000000000000000000061");
const runB = Id.parse("00000000000000000000000062");

class FakeClock implements Clock {
  #time = 0;
  readonly #timers: { readonly at: number; readonly callback: () => void; active: boolean }[] = [];

  now(): number {
    return this.#time;
  }

  schedule(callback: () => void, delayMs: number): () => void {
    const timer = { at: this.#time + delayMs, callback, active: true };
    this.#timers.push(timer);
    return () => {
      timer.active = false;
    };
  }

  advanceBy(milliseconds: number): void {
    this.#time += milliseconds;
    for (const timer of this.#timers) {
      if (timer.active && timer.at <= this.#time) {
        timer.active = false;
        timer.callback();
      }
    }
  }
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolveDeferred = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    resolveDeferred = resolve;
  });
  return { promise, resolve: resolveDeferred };
}

let root: string | undefined;

afterEach(async () => {
  const temporaryRoot = root;
  root = undefined;
  if (temporaryRoot !== undefined) {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

describe("RunnerLeaseManager", () => {
  // threat: T-14
  it("seals persisted run workspaces before the first lease after restart", async () => {
    root = await mkdtemp(join(tmpdir(), "sandbox-lease-restart-"));
    const managerBeforeRestart = new RunnerLeaseManager({ workspaceRoot: root });
    expect(await managerBeforeRestart.acquire(runA, 10_000)).toBe(true);

    const managerAfterRestart = new RunnerLeaseManager({ workspaceRoot: root });
    expect(await managerAfterRestart.acquire(runB, 10_000)).toBe(true);
    expect((await stat(join(root, runA))).mode & 0o777).toBe(0o700);
  });

  it("serializes acquisition behind an in-progress workspace preparation", async () => {
    root = await mkdtemp(join(tmpdir(), "sandbox-lease-prepare-"));
    const started = deferred();
    const finishActivation = deferred();
    const activate = vi.fn(async (_workspaceRoot: string, runId: typeof runA) => {
      if (runId === runA) {
        started.resolve();
        await finishActivation.promise;
      }
      return join(root ?? "", runId, "project");
    });
    const manager = new RunnerLeaseManager({
      workspaceRoot: root,
      workspaceOperations: {
        activate,
        clearScratch: () => Promise.resolve(),
        lock: () => Promise.resolve(),
        sealPersisted: () => Promise.resolve(),
      },
    });
    const acquireA = manager.acquire(runA, 10_000);
    await started.promise;
    const acquireB = manager.acquire(runB, 10_000);
    finishActivation.resolve();

    await expect(acquireA).resolves.toBe(true);
    await expect(acquireB).resolves.toBe(false);
    expect(activate).toHaveBeenCalledTimes(1);
    expect(await manager.release(runA)).toBe(true);
    await expect(manager.release(runA)).resolves.toBe(true);
  });

  it("does not let a delayed expiry lock a lease acquired afterward", async () => {
    root = await mkdtemp(join(tmpdir(), "sandbox-lease-expiry-"));
    const clock = new FakeClock();
    const lockStarted = deferred();
    const finishLock = deferred();
    let delayLock = true;
    const lock = vi.fn(async (_workspaceRoot: string, runId: typeof runA) => {
      if (runId === runA && delayLock) {
        delayLock = false;
        lockStarted.resolve();
        await finishLock.promise;
      }
    });
    const manager = new RunnerLeaseManager({
      workspaceRoot: root,
      clock,
      workspaceOperations: {
        activate: () => Promise.resolve(""),
        clearScratch: () => Promise.resolve(),
        lock,
        sealPersisted: () => Promise.resolve(),
      },
    });
    await expect(manager.acquire(runA, 100)).resolves.toBe(true);
    clock.advanceBy(101);
    await lockStarted.promise;
    const acquireB = manager.acquire(runB, 100);
    finishLock.resolve();

    await expect(acquireB).resolves.toBe(true);
    expect(lock).toHaveBeenCalledExactlyOnceWith(root, runA);
    await expect(manager.release(runB)).resolves.toBe(true);
  });

  it("pins an expired lease while an execution is active", async () => {
    root = await mkdtemp(join(tmpdir(), "sandbox-lease-active-"));
    const clock = new FakeClock();
    let busy = false;
    const manager = new RunnerLeaseManager({
      workspaceRoot: root,
      clock,
      isBusy: () => busy,
      workspaceOperations: {
        activate: () => Promise.resolve(""),
        clearScratch: () => Promise.resolve(),
        lock: () => Promise.resolve(),
        sealPersisted: () => Promise.resolve(),
      },
    });
    await expect(manager.acquire(runA, 100)).resolves.toBe(true);
    busy = true;
    clock.advanceBy(101);
    await expect(manager.acquire(runB, 100)).resolves.toBe(false);
    busy = false;
    await manager.expireDue();
    await expect(manager.acquire(runB, 100)).resolves.toBe(true);
  });

  it("clears command-owned scratch paths through the execution uid", async () => {
    root = await mkdtemp(join(tmpdir(), "sandbox-lease-cleanup-"));
    const clearScratchSpy = vi.fn(clearRunScratch);
    const sealSpy = vi.fn(sealPersistedRunWorkspaces);
    const manager = new RunnerLeaseManager({
      workspaceRoot: root,
      workspaceOperations: {
        activate: activateRunWorkspace,
        clearScratch: clearScratchSpy,
        lock: lockRunWorkspace,
        sealPersisted: sealSpy,
      },
    });
    await expect(manager.acquire(runA, 10_000)).resolves.toBe(true);
    expect(clearScratchSpy).toHaveBeenCalledOnce();
    expect(sealSpy).toHaveBeenCalledOnce();
    await expect(manager.release(runA)).resolves.toBe(true);
  });
});
