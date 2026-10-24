// SPDX-License-Identifier: Apache-2.0
import { HarnessError, type Id } from "@rovinos/schemas";

/** Raised when a run is assigned conflicting vault scopes. */
export class RunScopeConflictError extends HarnessError {
  readonly code = "run_scope_conflict";

  constructor() {
    super("A run cannot be assigned to multiple vault scopes.");
  }
}

/** Resolves every run in a subagent tree to its root run's vault scope. */
export class RunScopeRegistry {
  private readonly scopes = new Map<Id, Id>();

  /**
   * Assign a run to a vault scope.
   *
   * @param runId - Run receiving the scope assignment.
   * @param scopeId - Root run whose vault entries the run can access.
   * @throws RunScopeConflictError when the run already has another scope.
   */
  register = (runId: Id, scopeId: Id): void => {
    const current = this.scopes.get(runId);
    if (current !== undefined && current !== scopeId) {
      throw new RunScopeConflictError();
    }
    this.scopes.set(runId, scopeId);
  };

  /**
   * Return the assigned scope, defaulting to the run itself for root runs.
   *
   * @param runId - Run whose vault scope is requested.
   * @returns The root run's vault scope identifier.
   */
  scopeOf = (runId: Id): Id => {
    return this.scopes.get(runId) ?? runId;
  };

  /** Return an explicitly registered scope without falling back to the run ID. */
  registeredScopeOf(runId: Id): Id | undefined {
    return this.scopes.get(runId);
  }
}
