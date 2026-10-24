// SPDX-License-Identifier: Apache-2.0
import { Id } from "@rovinos/schemas";
import { describe, expect, it } from "vitest";
import { RunScopeConflictError, RunScopeRegistry } from "./scope.js";

const runId = Id.parse("00000000000000000000000000");
const rootId = Id.parse("11111111111111111111111111");

describe("RunScopeRegistry", () => {
  it("uses the run itself as the default root scope", () => {
    const scopeOf = new RunScopeRegistry().scopeOf;
    expect(scopeOf(runId)).toBe(runId);
  });

  it("resolves child runs to their registered root scope", () => {
    const scopes = new RunScopeRegistry();

    scopes.register(runId, rootId);

    expect(scopes.scopeOf(runId)).toBe(rootId);
  });

  it("allows idempotent registration but rejects a conflicting scope", () => {
    const scopes = new RunScopeRegistry();
    scopes.register(runId, rootId);

    expect(() => {
      scopes.register(runId, rootId);
    }).not.toThrow();
    expect(() => {
      scopes.register(runId, runId);
    }).toThrow(RunScopeConflictError);
  });
});
