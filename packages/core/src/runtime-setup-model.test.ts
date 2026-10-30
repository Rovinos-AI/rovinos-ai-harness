// SPDX-License-Identifier: Apache-2.0
import {
  Code,
  Id,
  ModelsConfigSchema,
  PiiConfigSchema,
  RunConfigSchema,
  SequentialIdGenerator,
  type ModelRequest,
} from "@rovinos/schemas";
import { InMemoryEventStore } from "@rovinos/store";
import { createEventBuilders } from "@rovinos/store/testing";
import { InMemoryVault } from "@rovinos/vault";
import type { ProviderAdapter } from "@rovinos/models";
import { describe, expect, it, vi } from "vitest";
import { createRuntimeModelAndStore } from "./runtime-setup-model.js";
import { RunScopeRegistry } from "./subagent/scope.js";

const email = "scope-test@example.test";
const rootRunId = Id.parse("00000000000000000000000001");
const childRunId = Id.parse("00000000000000000000000002");
const scopeId = Id.parse("00000000000000000000000003");

function request(text: string): ModelRequest {
  return {
    requestId: Id.parse("00000000000000000000000004"),
    model: { provider: Code.parse("local"), model: Code.parse("test-model") },
    messages: [{ role: "user", parts: [{ type: "text", text }] }],
  };
}

function providerAdapter(received: ModelRequest[]): ProviderAdapter {
  return {
    provider: Code.parse("local"),
    kind: "openai",
    complete: (modelRequest) => {
      received.push(modelRequest);
      return Promise.resolve({
        parts: [{ type: "text", text: "completed" }],
        usage: { inputTokens: 1, outputTokens: 1 },
        finishReason: "stop",
        latencyMs: 0,
      });
    },
  };
}

async function setup(
  options: {
    readonly store?: InMemoryEventStore;
    readonly scopes?: RunScopeRegistry;
    readonly registeredScope?: { readonly runId: Id; readonly scopeId: Id };
  } = {},
) {
  const store = options.store ?? new InMemoryEventStore();
  const scopes = options.scopes ?? new RunScopeRegistry();
  const vault = Object.assign(new InMemoryVault(), { close: () => Promise.resolve() });
  const token = await vault.put(scopeId, Code.parse("email"), email);
  if (options.registeredScope !== undefined) {
    scopes.register(options.registeredScope.runId, options.registeredScope.scopeId);
  }
  const received: ModelRequest[] = [];
  const models = ModelsConfigSchema.parse({
    providers: [
      {
        id: "local",
        kind: "openai_compatible",
        baseUrl: "http://127.0.0.1:1234",
        trust: "local",
      },
    ],
    routing: { default: [{ provider: "local", model: "test-model" }] },
  });
  const created = await createRuntimeModelAndStore({
    config: { run: RunConfigSchema.parse({}), models },
    piiConfig: PiiConfigSchema.parse({
      allowRawToLocalModels: true,
      rules: [
        {
          entities: ["email"],
          boundaries: ["model_input"],
          destinations: ["local"],
          action: "allow",
        },
      ],
    }),
    overrides: { providerAdapters: [providerAdapter(received)] },
    ids: new SequentialIdGenerator(),
    clock: { now: () => 1 },
    vault,
    scopes,
    store,
    policyVersion: Code.parse("test.policy"),
  });
  return { ...created, received, scopes, store, token, vault };
}

describe("runtime model scope resolution", () => {
  it("resolves a persisted child scope and reuses the registered scope for later requests", async () => {
    const builders = createEventBuilders();
    const store = new InMemoryEventStore();
    await store.append(rootRunId, [builders.runCreated(rootRunId)], 0);
    await store.append(childRunId, [builders.runCreated(childRunId, rootRunId)], 0);
    const scopes = new RunScopeRegistry();
    scopes.register(rootRunId, scopeId);
    const fixture = await setup({ store, scopes });

    await fixture.model.complete(request(fixture.token), {
      runId: childRunId,
      signal: new AbortController().signal,
    });
    await fixture.model.complete(request(fixture.token), {
      runId: childRunId,
      signal: new AbortController().signal,
    });

    expect(fixture.received).toHaveLength(2);
    expect(fixture.received[0]?.messages[0]?.parts[0]).toMatchObject({
      type: "text",
      text: email,
    });
    expect(fixture.scopes.registeredScopeOf(childRunId)).toBe(scopeId);
    await store.close();
  });

  it("shares an in-flight scope lookup between simultaneous requests", async () => {
    const builders = createEventBuilders();
    const store = new InMemoryEventStore();
    await store.append(rootRunId, [builders.runCreated(rootRunId)], 0);
    await store.append(childRunId, [builders.runCreated(childRunId, rootRunId)], 0);
    const scopes = new RunScopeRegistry();
    scopes.register(rootRunId, scopeId);
    const originalRead = store.read.bind(store);
    const childReads = vi.fn();
    let releaseRead: () => void = () => undefined;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    vi.spyOn(store, "read").mockImplementation((runId, range) => {
      if (runId !== childRunId) {
        return originalRead(runId, range);
      }
      childReads();
      return (async function* () {
        await readGate;
        yield* originalRead(runId, range);
      })();
    });
    const fixture = await setup({ store, scopes });
    const context = { runId: childRunId, signal: new AbortController().signal };
    const first = fixture.model.complete(request(fixture.token), context);
    await vi.waitFor(() => {
      expect(childReads).toHaveBeenCalledOnce();
    });
    const second = fixture.model.complete(request(fixture.token), context);
    await Promise.resolve();
    expect(childReads).toHaveBeenCalledOnce();
    releaseRead();
    await Promise.all([first, second]);
    expect(fixture.received).toHaveLength(2);
    await store.close();
  });

  it("breaks persisted parent cycles and defaults runs without creation events to themselves", async () => {
    const builders = createEventBuilders();
    const store = new InMemoryEventStore();
    await store.append(rootRunId, [builders.runCreated(rootRunId, childRunId)], 0);
    await store.append(childRunId, [builders.runCreated(childRunId, rootRunId)], 0);
    const fixture = await setup({ store });
    const token = await fixture.vault.put(childRunId, Code.parse("email"), email);

    await fixture.model.complete(request(token), {
      runId: childRunId,
      signal: new AbortController().signal,
    });
    expect(fixture.scopes.registeredScopeOf(childRunId)).toBe(childRunId);

    const unknownRunId = Id.parse("00000000000000000000000005");
    await fixture.model.complete(request(email), {
      runId: unknownRunId,
      signal: new AbortController().signal,
    });
    expect(fixture.received.at(-1)?.messages[0]?.parts[0]).toMatchObject({
      type: "text",
      text: email,
    });
    await store.close();
  });
});
