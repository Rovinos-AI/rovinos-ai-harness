// SPDX-License-Identifier: Apache-2.0
import type { Readable } from "node:stream";
import type { Id } from "@rovinos/schemas";
import { RemoteSandboxError } from "./remote-errors.js";
import type { FsOperation, FsToolResult, WorkspaceFileToolBackend } from "./fs-tools.js";
import type { WebFetchRequest, WebFetchResult } from "./web-fetch-contracts.js";
import type { WebFetchBackend } from "./web-fetch-tool.js";
import type { RemoteWorkspaceSnapshotPort } from "./snapshot.js";
import type { ExecResult, ExecSpec, SandboxBackend } from "./types.js";

const DEFAULT_HEALTH_COOLDOWN_MS = 5_000;

/** Inputs used to choose and temporarily evict remote sandbox runners. */
export interface RunnerPoolOptions {
  /** Remote runner backends. Each runner still enforces a one-run lease. */
  readonly runners: readonly RunnerPoolRunner[];
  /** Current epoch time in milliseconds. */
  readonly now?: () => number;
  /** Random number in [0, 1), used to choose the lease attempt order. */
  readonly random?: () => number;
  /** Time before a runner that failed a health check can be retried. */
  readonly healthCooldownMs?: number;
}

/** Required runner operations routed while a run holds its lease. */
export interface RunnerPoolRunner
  extends SandboxBackend, WorkspaceFileToolBackend, WebFetchBackend, RemoteWorkspaceSnapshotPort {
  /** Checks whether the runner is ready to accept a lease. */
  healthCheck(): Promise<boolean>;
  /** Acquires the runner lease for one run. */
  acquireLease(runId: Id, ttlMs?: number): Promise<void>;
  /** Releases the runner lease for one run. */
  releaseLease(runId: Id): Promise<void>;
}

/**
 * Selects a healthy runner for each run and routes all workspace operations to that lease.
 *
 * @param options - Runner backends and deterministic selection/health dependencies.
 */
export class RunnerPool
  implements SandboxBackend, WorkspaceFileToolBackend, WebFetchBackend, RemoteWorkspaceSnapshotPort
{
  readonly #now: () => number;
  readonly #random: () => number;
  readonly #healthCooldownMs: number;
  readonly #leases = new Map<Id, RunnerPoolRunner>();
  readonly #workspaceExistedBeforeLease = new Map<Id, boolean>();
  readonly #unavailableUntil = new Map<RunnerPoolRunner, number>();

  constructor(private readonly options: RunnerPoolOptions) {
    if (
      options.runners.length === 0 ||
      (options.healthCooldownMs !== undefined &&
        (!Number.isSafeInteger(options.healthCooldownMs) || options.healthCooldownMs < 1))
    ) {
      throw new RemoteSandboxError("sandbox_runner_config_invalid");
    }
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? Math.random;
    this.#healthCooldownMs = options.healthCooldownMs ?? DEFAULT_HEALTH_COOLDOWN_MS;
  }

  /** Acquires a healthy runner lease, skipping runners that are busy or temporarily unhealthy. */
  async acquireLease(runId: Id, ttlMs?: number): Promise<void> {
    const assigned = this.#leases.get(runId);
    if (assigned !== undefined) {
      await assigned.acquireLease(runId, ttlMs);
      return;
    }
    let busy = false;
    for (const runner of this.#randomizedRunners()) {
      if ((this.#unavailableUntil.get(runner) ?? 0) > this.#now()) {
        continue;
      }
      let healthy: boolean;
      try {
        healthy = await runner.healthCheck();
      } catch {
        this.#evict(runner);
        continue;
      }
      if (!healthy) {
        this.#evict(runner);
        continue;
      }
      let workspaceExisted: boolean;
      try {
        workspaceExisted = await runner.hasWorkspace(runId);
      } catch {
        this.#evict(runner);
        continue;
      }
      try {
        await runner.acquireLease(runId, ttlMs);
        this.#unavailableUntil.delete(runner);
        this.#leases.set(runId, runner);
        this.#workspaceExistedBeforeLease.set(runId, workspaceExisted);
        return;
      } catch (error) {
        if (error instanceof RemoteSandboxError && error.code === "sandbox_busy") {
          busy = true;
        } else {
          this.#evict(runner);
        }
      }
    }
    throw new RemoteSandboxError(busy ? "sandbox_busy" : "sandbox_unavailable");
  }

  /** Releases the selected runner after the run suspends or reaches a terminal state. */
  async releaseLease(runId: Id): Promise<void> {
    const runner = this.#leases.get(runId);
    if (runner === undefined) {
      return;
    }
    try {
      await runner.releaseLease(runId);
    } finally {
      if (this.#leases.get(runId) === runner) {
        this.#leases.delete(runId);
        this.#workspaceExistedBeforeLease.delete(runId);
      }
    }
  }

  /** Executes a command on the runner leased to this run. */
  async exec(runId: Id, spec: ExecSpec, signal: AbortSignal): Promise<ExecResult> {
    return this.#runnerFor(runId).exec(runId, spec, signal);
  }

  /** Fetches allowlisted content through the runner leased to this run. */
  async fetch(runId: Id, request: WebFetchRequest, signal: AbortSignal): Promise<WebFetchResult> {
    return this.#runnerFor(runId).fetch(runId, request, signal);
  }

  /** Performs a workspace file operation on the runner leased to this run. */
  async fileOperation(
    runId: Id,
    operation: FsOperation,
    input: unknown,
    signal: AbortSignal,
  ): Promise<FsToolResult> {
    return this.#runnerFor(runId).fileOperation(runId, operation, input, signal);
  }

  /** Creates a snapshot archive from the workspace on the run's assigned runner. */
  async createArchive(
    runId: Id,
    maxFileBytes: number,
    maxSnapshotBytes: number,
  ): Promise<Readable> {
    return this.#runnerFor(runId).createArchive(runId, maxFileBytes, maxSnapshotBytes);
  }

  /** Restores a verified snapshot into the workspace on the run's assigned runner. */
  async restoreArchive(
    runId: Id,
    archive: Readable,
    maxFileBytes: number,
    maxSnapshotBytes: number,
  ): Promise<void> {
    await this.#runnerFor(runId).restoreArchive(runId, archive, maxFileBytes, maxSnapshotBytes);
    this.#workspaceExistedBeforeLease.set(runId, true);
  }

  /** Checks for a workspace on the runner currently assigned to the run. */
  async hasWorkspace(runId: Id): Promise<boolean> {
    if (this.#workspaceExistedBeforeLease.get(runId) === false) {
      return false;
    }
    return this.#runnerFor(runId).hasWorkspace(runId);
  }

  /** Releases any remaining runner leases when the runtime closes. */
  async close(): Promise<void> {
    await Promise.all([...this.#leases.keys()].map((runId) => this.releaseLease(runId)));
  }

  #runnerFor(runId: Id): RunnerPoolRunner {
    const runner = this.#leases.get(runId);
    if (runner === undefined) {
      throw new RemoteSandboxError("sandbox_unavailable");
    }
    return runner;
  }

  #evict(runner: RunnerPoolRunner): void {
    this.#unavailableUntil.set(runner, this.#now() + this.#healthCooldownMs);
  }

  #randomizedRunners(): RunnerPoolRunner[] {
    const runners = [...this.options.runners];
    for (let index = runners.length - 1; index > 0; index -= 1) {
      const randomIndex = Math.min(index, Math.max(0, Math.floor(this.#random() * (index + 1))));
      const current = runners[index];
      const selected = runners[randomIndex];
      if (current !== undefined && selected !== undefined) {
        runners[index] = selected;
        runners[randomIndex] = current;
      }
    }
    return runners;
  }
}
