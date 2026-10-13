// SPDX-License-Identifier: Apache-2.0
import type { ModelRequest } from "@harness/schemas";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderAdapter, ProviderContext, ProviderResult } from "../types.js";
import {
  CassetteAutoDisabledError,
  CassetteInnerRequiredError,
  CassetteMissError,
  CassetteProvider,
  type CassetteEntry,
  type CassetteStore,
} from "./cassette-provider.js";
import { requestHash } from "./hash.js";

const request: ModelRequest = {
  requestId: "00000000000000000000000001",
  model: { provider: "cassette", model: "test" },
  messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }],
};
const result: ProviderResult = {
  parts: [{ type: "text", text: "recorded response" }],
  usage: { inputTokens: 2, outputTokens: 3 },
  finishReason: "stop",
  latencyMs: 5,
};
const context: ProviderContext = {
  signal: new AbortController().signal,
  ids: { next: () => "00000000000000000000000002" },
  clock: { now: () => 1 },
};

function memoryStore(): CassetteStore & { readonly entries: Map<string, CassetteEntry> } {
  const entries = new Map<string, CassetteEntry>();
  return {
    entries,
    async get(hash) {
      return entries.get(hash)?.response;
    },
    async set(entry) {
      entries.set(entry.hash, entry);
    },
  };
}

function innerAdapter(complete: ProviderAdapter["complete"]): ProviderAdapter {
  return { provider: "openai", kind: "openai", complete };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("CassetteProvider", () => {
  it("records and replays a response unchanged", async () => {
    const store = memoryStore();
    const inner = innerAdapter(vi.fn(async () => result));
    const recorder = new CassetteProvider("record", store, inner);
    const recorded = await recorder.complete(request, context);
    const replay = new CassetteProvider("replay", store);

    expect(recorded).toEqual(result);
    expect(await replay.complete(request, context)).toEqual(result);
    expect(inner.complete).toHaveBeenCalledOnce();
    expect(store.entries.get(requestHash(request))).toEqual({ hash: requestHash(request), response: result });
  });

  it("reports the missing request hash in replay mode", async () => {
    const replay = new CassetteProvider("replay", memoryStore());

    await expect(replay.complete(request, context)).rejects.toMatchObject({
      code: "cassette_miss",
      hash: requestHash(request),
    } satisfies Partial<CassetteMissError>);
  });

  it("auto mode replays a hit and records a miss", async () => {
    const store = memoryStore();
    const hash = requestHash(request);
    await store.set({ hash, response: result });
    const inner = innerAdapter(vi.fn(async () => result));
    const auto = new CassetteProvider("auto", store, inner);
    expect(await auto.complete(request, context)).toEqual(result);
    expect(inner.complete).not.toHaveBeenCalled();

    const nextRequest = { ...request, requestId: "00000000000000000000000003" };
    const recorded = await auto.complete(
      { ...nextRequest, messages: [{ role: "user", parts: [{ type: "text", text: "new" }] }] },
      context,
    );
    expect(recorded).toEqual(result);
    expect(inner.complete).toHaveBeenCalledOnce();
  });

  it("disables auto mode when HARNESS_CASSETTE_AUTO is zero", () => {
    vi.stubEnv("HARNESS_CASSETTE_AUTO", "0");

    expect(() => new CassetteProvider("auto", memoryStore(), innerAdapter(vi.fn()))).toThrow(
      CassetteAutoDisabledError,
    );
  });

  it("requires an inner adapter only when a request must be recorded", async () => {
    const recorder = new CassetteProvider("record", memoryStore());

    await expect(recorder.complete(request, context)).rejects.toBeInstanceOf(
      CassetteInnerRequiredError,
    );
  });
});
