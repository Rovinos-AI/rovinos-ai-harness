// SPDX-License-Identifier: Apache-2.0
import type { Code, Id, PiiConfig } from "@harness/schemas";
import { PiiEventStore } from "@harness/pii";
import type { RequestSanitizer } from "@harness/models";
import type { EventStore } from "@harness/store";
import { missingModelPort } from "./runtime-default-ports.js";
import { createConfiguredModelPort } from "./runtime-model.js";
import { createRuntimePii } from "./runtime-pii.js";
import type {
  RuntimeComposition,
  RuntimeConfig,
  RuntimeOverrides,
  RuntimeVault,
} from "./runtime-config.js";
import type { Clock } from "./recorder.js";
import type { RunScopeRegistry } from "./subagent/scope.js";

function persistedScopeResolver(store: EventStore, scopes: RunScopeRegistry) {
  const pending = new Map<Id, Promise<Id>>();
  const resolve = async (runId: Id, visited: Set<Id>): Promise<Id> => {
    const registered = scopes.registeredScopeOf(runId);
    if (registered !== undefined) {
      return registered;
    }
    if (visited.has(runId)) {
      return runId;
    }
    visited.add(runId);
    let scopeId: Id | undefined;
    let parentRunId: Id | undefined;
    for await (const event of store.read(runId, { fromSeq: 0, toSeq: 0 })) {
      if (event.type === "run_created") {
        scopeId = event.scopeId;
        parentRunId = event.parentRunId;
        break;
      }
    }
    scopeId ??= parentRunId === undefined ? runId : await resolve(parentRunId, visited);
    scopes.register(runId, scopeId);
    return scopeId;
  };
  return (runId: Id): Promise<Id> => {
    const known = scopes.registeredScopeOf(runId);
    if (known !== undefined) {
      return Promise.resolve(known);
    }
    const existing = pending.get(runId);
    if (existing !== undefined) {
      return existing;
    }
    const resolution = resolve(runId, new Set<Id>());
    pending.set(runId, resolution);
    return resolution;
  };
}

async function createRuntimeModel(
  config: RuntimeConfig,
  overrides: RuntimeOverrides,
  options: {
    readonly ids: RuntimeComposition["ids"];
    readonly clock: Clock;
    readonly requestSanitizer?: RequestSanitizer;
  },
): Promise<RuntimeComposition["model"]> {
  return (
    overrides.model ??
    (await createConfiguredModelPort(config.models, {
      ids: options.ids,
      clock: options.clock,
      ...(overrides.providerAdapters === undefined
        ? {}
        : { providerAdapters: overrides.providerAdapters }),
      ...(overrides.secretResolver === undefined
        ? {}
        : { secretResolver: overrides.secretResolver }),
      ...(options.requestSanitizer === undefined
        ? {}
        : { requestSanitizer: options.requestSanitizer }),
    })) ??
    missingModelPort
  );
}

/** Creates the runtime PII boundary, model port, and event-store wrapper. */
export async function createRuntimeModelAndStore(options: {
  readonly config: RuntimeConfig;
  readonly piiConfig: PiiConfig;
  readonly overrides: RuntimeOverrides;
  readonly ids: RuntimeComposition["ids"];
  readonly clock: Clock;
  readonly vault: RuntimeVault;
  readonly scopes: RunScopeRegistry;
  readonly store: EventStore;
  readonly policyVersion: Code;
}): Promise<{
  readonly piiRuntime: ReturnType<typeof createRuntimePii>;
  readonly model: RuntimeComposition["model"];
  readonly store: EventStore;
}> {
  const piiRuntime = createRuntimePii({
    config: options.piiConfig,
    vault: options.vault,
    scopes: options.scopes,
    scopeOf: persistedScopeResolver(options.store, options.scopes),
    policyVersion: options.policyVersion,
    clock: options.clock,
  });
  const requestSanitizer: RequestSanitizer | undefined =
    options.piiConfig.enabled && options.overrides.alreadyTokenized !== true
      ? (request, target, context) =>
        piiRuntime.messageSanitizer.sanitizeRequest(request, target, context.runId, {
          ...(context.recordPiiAction === undefined
            ? {}
            : { recordPiiAction: context.recordPiiAction }),
          signal: context.signal,
        })
      : undefined;
  const model = await createRuntimeModel(options.config, options.overrides, {
    ids: options.ids,
    clock: options.clock,
    ...(requestSanitizer === undefined ? {} : { requestSanitizer }),
  });
  return {
    piiRuntime,
    model,
    store: options.piiConfig.enabled
      ? new PiiEventStore(options.store, piiRuntime.tokenizer)
      : options.store,
  };
}
