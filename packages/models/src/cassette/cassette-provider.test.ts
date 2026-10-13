// SPDX-License-Identifier: Apache-2.0
import type { ModelRequest } from "@harness/schemas";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderAdapter, ProviderContext, ProviderResult } from "../types.js";
import {
  CassetteAutoDisabledError,
  CassetteInnerRequiredError,
  CassettePrivacyRequiredError,
  CassetteProvider,
  type CassetteEntry,
  type CassetteMissError,
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
const privacyOptions = {
  sanitize: (response: ProviderResult) => Promise.resolve(response),
  detectRealData: () => Promise.resolve(false),
};

function memoryStore(): CassetteStore & { readonly entries: Map<string, CassetteEntry> } {
  const entries = new Map<string, CassetteEntry>();
  return {
    entries,
    get: (hash) => Promise.resolve(entries.get(hash)?.response),
    set: (entry) => {
      entries.set(entry.hash, entry);
      return Promise.resolve();
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
    const complete = vi.fn(() => Promise.resolve(result));
    const inner = innerAdapter(complete);
    const recorder = new CassetteProvider("record", store, inner, privacyOptions);
    const recorded = await recorder.complete(request, context);
    const replay = new CassetteProvider("replay", store);

    expect(recorded).toEqual(result);
    expect(await replay.complete(request, context)).toEqual(result);
    expect(complete).toHaveBeenCalledOnce();
    expect(store.entries.get(requestHash(request))).toEqual({
      hash: requestHash(request),
      response: result,
    });
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
    const complete = vi.fn(() => Promise.resolve(result));
    const inner = innerAdapter(complete);
    const auto = new CassetteProvider("auto", store, inner, privacyOptions);
    expect(await auto.complete(request, context)).toEqual(result);
    expect(complete).not.toHaveBeenCalled();

    const nextRequest = { ...request, requestId: "00000000000000000000000003" };
    const recorded = await auto.complete(
      { ...nextRequest, messages: [{ role: "user", parts: [{ type: "text", text: "new" }] }] },
      context,
    );
    expect(recorded).toEqual(result);
    expect(complete).toHaveBeenCalledOnce();
  });

  it("disables auto mode when HARNESS_CASSETTE_AUTO is zero", () => {
    const complete = vi.fn<ProviderAdapter["complete"]>();
    expect(
      () =>
        new CassetteProvider("auto", memoryStore(), innerAdapter(complete), {
          ...privacyOptions,
          env: { HARNESS_CASSETTE_AUTO: "0" },
        }),
    ).toThrow(CassetteAutoDisabledError);
  });

  it("requires an inner adapter only when a request must be recorded", async () => {
    const recorder = new CassetteProvider("record", memoryStore(), undefined, privacyOptions);

    await expect(recorder.complete(request, context)).rejects.toBeInstanceOf(
      CassetteInnerRequiredError,
    );
  });

  it("requires sanitization and detection hooks for recording modes", () => {
    expect(() => new CassetteProvider("record", memoryStore(), innerAdapter(vi.fn()))).toThrow(
      CassettePrivacyRequiredError,
    );
  });

  it("tokenizes detected email content before storing", async () => {
    const store = memoryStore();
    const response: ProviderResult = {
      ...result,
      parts: [{ type: "text", text: "Contact synthetic@example.test" }],
    };
    const recorder = new CassetteProvider(
      "record",
      store,
      innerAdapter(() => Promise.resolve(response)),
      {
        sanitize: (value) =>
          Promise.resolve({
            ...value,
            parts: value.parts.map((part) =>
              part.type === "text"
                ? { ...part, text: part.text.replace("synthetic@example.test", "[EMAIL]") }
                : part,
            ),
          }),
        detectRealData: (value) => Promise.resolve(JSON.stringify(value).includes("@")),
      },
    );

    await recorder.complete(request, context);

    expect(store.entries.get(requestHash(request))?.response.parts).toEqual([
      { type: "text", text: "Contact [EMAIL]" },
    ]);
  });

  it("refuses to persist content still detected after sanitization", async () => {
    const store = memoryStore();
    const sensitiveResponse: ProviderResult = {
      ...result,
      parts: [{ type: "text", text: "synthetic@example.test" }],
    };
    const recorder = new CassetteProvider(
      "record",
      store,
      innerAdapter(() => Promise.resolve(sensitiveResponse)),
      {
        ...privacyOptions,
        detectRealData: () => Promise.resolve(true),
      },
    );

    const error = await recorder.complete(request, context).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "cassette_real_data_detected" });
    expect(error).toHaveProperty("message", "A cassette response contains detected real data.");
    expect(JSON.stringify(error)).not.toContain("synthetic@example.test");
    expect(store.entries.size).toBe(0);
  });

  it("returns and replays byte-identical responses with all optional fields", async () => {
    const store = memoryStore();
    const response: ProviderResult = {
      parts: [
        {
          type: "tool_call",
          callId: "00000000000000000000000005",
          toolId: "lookup",
          args: { query: "sample" },
        },
        { type: "opaque", provider: "openai", blob: { id: "opaque-id" } },
      ],
      usage: { inputTokens: 2, outputTokens: 3, costMicros: 9 },
      finishReason: "tool_calls",
      latencyMs: 5,
    };
    const recorded = await new CassetteProvider(
      "record",
      store,
      innerAdapter(() => Promise.resolve(response)),
      privacyOptions,
    ).complete(request, context);
    const replayed = await new CassetteProvider("replay", store).complete(request, context);

    expect(JSON.stringify(recorded)).toBe(JSON.stringify(replayed));
  });
});
