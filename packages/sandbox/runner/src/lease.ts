// SPDX-License-Identifier: Apache-2.0
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Id as IdValue } from "@harness/schemas";
import { activateRunWorkspace, clearRunScratch, lockRunWorkspace } from "../../src/workspace.js";
import type { Clock } from "../../src/types.js";

/** Default duration of a runner lease in milliseconds. */
export const DEFAULT_RUNNER_LEASE_TTL_MS = 10 * 60 * 1000;

const systemClock: Clock = {
  now: () => Date.now(),
  schedule: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    return () => {
      clearTimeout(timer);
    };
  },
};

/** Runner lease configuration required by the lease manager. */
export interface RunnerLeaseOptions {
  /** Root containing the per-run workspace directories. */
  readonly workspaceRoot: string;
  /** Optional runner scratch root wiped when a new lease begins. */
  readonly temporaryRoot?: string;
  /** Injectable clock used for deterministic lease expiry tests. */
  readonly clock?: Clock;
}

interface ActiveRunLease {
  readonly runId: IdValue;
  readonly ttlMs: number;
  readonly expiresAt: number;
}

/** Maintains the exclusive run lease and seals workspace permissions at release. */
export class RunnerLeaseManager {
  readonly #workspaceRoot: string;
  readonly #temporaryRoot: string | undefined;
  readonly #clock: Clock;
  #active: ActiveRunLease | undefined;
  #cancelExpiry: (() => void) | undefined;

  constructor(options: RunnerLeaseOptions) {
    this.#workspaceRoot = options.workspaceRoot;
    this.#temporaryRoot = options.temporaryRoot;
    this.#clock = options.clock ?? systemClock;
  }

  /** Acquires the lease, or renews it when it already belongs to this run. */
  async acquire(runId: IdValue, ttlMs = DEFAULT_RUNNER_LEASE_TTL_MS): Promise<boolean> {
    await this.#expireIfDue();
    if (this.#active !== undefined && this.#active.runId !== runId) {
      return false;
    }
    const isRenewal = this.#active?.runId === runId;
    this.#setActive(runId, ttlMs);
    try {
      if (!isRenewal) {
        await activateRunWorkspace(this.#workspaceRoot, runId);
        await clearRunScratch(this.#workspaceRoot, runId);
        await this.#clearTemporaryRoot();
      }
      await this.#expireIfDue();
      return this.#active?.runId === runId;
    } catch (error) {
      if (!isRenewal && this.#active?.runId === runId) {
        await this.#dropActive();
      }
      throw error;
    }
  }

  /** Releases the lease only when it is owned by the requesting run. */
  async release(runId: IdValue): Promise<boolean> {
    await this.#expireIfDue();
    if (this.#active?.runId !== runId) {
      return false;
    }
    await this.#dropActive();
    return true;
  }

  /** Renews the current lease for an execution request, claiming it if unowned. */
  async renew(runId: IdValue): Promise<boolean> {
    return this.acquire(runId, this.#active?.runId === runId ? this.#active.ttlMs : undefined);
  }

  async #dropActive(): Promise<void> {
    const active = this.#active;
    if (active === undefined) {
      return;
    }
    await lockRunWorkspace(this.#workspaceRoot, active.runId);
    this.#cancelExpiry?.();
    this.#cancelExpiry = undefined;
    this.#active = undefined;
  }

  async #expireIfDue(): Promise<void> {
    if (this.#active !== undefined && this.#active.expiresAt <= this.#clock.now()) {
      await this.#dropActive();
    }
  }

  #setActive(runId: IdValue, ttlMs: number): void {
    this.#cancelExpiry?.();
    const expiresAt = this.#clock.now() + ttlMs;
    this.#active = { runId, ttlMs, expiresAt };
    this.#cancelExpiry = this.#clock.schedule(() => {
      if (this.#active?.runId === runId && this.#active.expiresAt <= this.#clock.now()) {
        void this.release(runId);
      }
    }, ttlMs);
  }

  async #clearTemporaryRoot(): Promise<void> {
    const temporaryRoot = this.#temporaryRoot;
    if (temporaryRoot === undefined) {
      return;
    }
    const entries = await readdir(temporaryRoot);
    await Promise.all(
      entries.map((entry) =>
        rm(join(temporaryRoot, entry), {
          force: true,
          recursive: true,
        }),
      ),
    );
  }
}
