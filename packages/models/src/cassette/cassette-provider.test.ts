// SPDX-License-Identifier: Apache-2.0
import type { ModelRequest, Part } from "@rovinos/schemas";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runProviderContract,
  type ProviderContractAdapterOptions,
  type ProviderContractFixture,
} from "../contract.js";
import type { ProviderAdapter, ProviderContext, ProviderDelta, ProviderResult } from "../types.js";
import { assembleDeltas } from "../types.js";
import { ProviderError } from "../errors.js";
import {
  CassetteAutoDisabledError,
  CassetteMissError,
  CassetteInnerRequiredError,
  CassettePrivacyRequiredError,
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
const privacyOptions = {
  sanitize: (response: ProviderResult) => Promise.resolve(response),
  detectRealData: () => Promise.resolve(false),
};

function memoryStore(
  getDelayMs = 0,
): CassetteStore & { readonly entries: Map<string, CassetteEntry> } {
  const entries = new Map<string, CassetteEntry>();
  return {
    entries,
    async get(hash) {
      if (getDelayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, getDelayMs));
      }
      return entries.get(hash)?.response;
    },
    set: (entry) => {
      entries.set(entry.hash, entry);
      return Promise.resolve();
    },
  };
}

function innerAdapter(complete: ProviderAdapter["complete"]): ProviderAdapter {
  return { provider: "openai", kind: "openai", complete };
}

function contractFixture(
  scenario: ProviderContractFixture["scenario"],
  status: number,
): ProviderContractFixture {
  const parts: Part[] =
    scenario === "tool_call"
      ? [
          {
            type: "tool_call",
            callId: request.requestId,
            toolId: "lookup",
            args: { key: "value" },
          },
        ]
      : [{ type: "text", text: "answer" }];
  let expected: ProviderContractFixture["expected"];
  switch (scenario) {
    case "error_429":
      expected = { retryAfterMs: 2_000, status };
      break;
    case "error_500":
    case "error_401":
      expected = { status };
      break;
    case "abort_signal":
      expected = undefined;
      break;
    case "text_only":
    case "tool_call":
    case "usage_mapping":
      expected = {
        parts,
        usage: { inputTokens: 2, outputTokens: 3 },
        finishReason: "stop",
      };
      break;
  }
  return {
    scenario,
    request: {
      ...request,
      model: { provider: "cassette", model: scenario },
    },
    httpResponse: {
      status,
      ...(scenario === "error_429" ? { headers: { "retry-after": "2" } } : {}),
      body: { fixture: scenario },
    },
    ...(expected === undefined ? {} : { expected }),
  };
}

const contractFixtures = [
  contractFixture("text_only", 200),
  contractFixture("tool_call", 200),
  contractFixture("usage_mapping", 200),
  contractFixture("error_429", 429),
  contractFixture("error_500", 500),
  contractFixture("error_401", 401),
  contractFixture("abort_signal", 200),
];
const replayContractFixtures = contractFixtures.filter(
  ({ scenario }) =>
    scenario === "text_only" ||
    scenario === "tool_call" ||
    scenario === "usage_mapping" ||
    scenario === "abort_signal",
);

function contractResult(fixture: ProviderContractFixture): ProviderResult {
  return {
    parts: fixture.expected?.parts ?? ([{ type: "text", text: "answer" }] satisfies Part[]),
    usage: fixture.expected?.usage ?? { inputTokens: 2, outputTokens: 3 },
    finishReason: fixture.expected?.finishReason ?? "stop",
    latencyMs: 1,
  };
}

function contractFixtureProvider(
  options: ProviderContractAdapterOptions,
  fixture: ProviderContractFixture,
): ProviderAdapter {
  return {
    provider: "fixture",
    kind: "openai",
    async complete(requestToComplete, providerContext) {
      const response = await options.fetch(`${options.baseUrl}/complete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestToComplete),
        signal: providerContext.signal,
      });
      await response.arrayBuffer();
      if (response.status === 429) {
        throw new ProviderError("provider_rate_limited", {
          retryAfterMs: 2_000,
          status: response.status,
        });
      }
      if (response.status >= 500) {
        throw new ProviderError("provider_unavailable", { status: response.status });
      }
      if (response.status === 401) {
        throw new ProviderError("provider_auth", { status: response.status });
      }
      return contractResult(fixture);
    },
  };
}

const contractPrivacyOptions = {
  sanitize: (response: ProviderResult) => Promise.resolve(response),
  detectRealData: () => Promise.resolve(false),
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("CassetteProvider", () => {
  it("records only the assembled result from a successful stream", async () => {
    const store = memoryStore();
    const inner: ProviderAdapter = {
      provider: "openai",
      kind: "openai",
      complete: () => Promise.reject(new Error("stream path expected")),
      async *stream() {
        await Promise.resolve();
        yield { type: "text", index: 0, text: "recorded " };
        yield { type: "text", index: 0, text: "response" };
        yield { type: "usage", usage: result.usage };
        yield { type: "finish", finishReason: result.finishReason, latencyMs: result.latencyMs };
      },
    };
    const recorder = new CassetteProvider("record", store, inner, privacyOptions);
    const deltas: ProviderDelta[] = [];
    for await (const delta of recorder.stream(request, context)) {
      deltas.push(delta);
    }

    expect(assembleDeltas(deltas)).toEqual(result);
    expect(store.entries.get(requestHash(request))?.response).toEqual(result);
  });

  it("does not persist or expose output when a provider stream fails partway through", async () => {
    const store = memoryStore();
    const inner: ProviderAdapter = {
      provider: "openai",
      kind: "openai",
      complete: () => Promise.reject(new Error("stream path expected")),
      async *stream() {
        await Promise.resolve();
        yield { type: "text", index: 0, text: "canary-partial-response" };
        throw new ProviderError("provider_unavailable");
      },
    };
    const recorder = new CassetteProvider("record", store, inner, privacyOptions);
    const seen: unknown[] = [];
    const promise = (async () => {
      for await (const delta of recorder.stream(request, context)) {
        seen.push(delta);
      }
    })();

    await expect(promise).rejects.toMatchObject({ code: "provider_unavailable" });
    expect(seen).toEqual([{ type: "activity" }]);
    expect(store.entries.size).toBe(0);
  });

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

  it("replays streamed tool-call and opaque response parts", async () => {
    const store = memoryStore();
    const replayResult: ProviderResult = {
      ...result,
      parts: [
        { type: "text", text: "recorded response" },
        {
          type: "tool_call",
          callId: "00000000000000000000000002",
          toolId: "lookup",
          args: { key: "value" },
        },
        { type: "opaque", provider: "openai", blob: { responseId: "response_fixture" } },
      ],
    };
    await store.set({ hash: requestHash(request), response: replayResult });
    const replay = new CassetteProvider("replay", store);
    const deltas: ProviderDelta[] = [];
    for await (const delta of replay.stream(request, context)) {
      deltas.push(delta);
    }

    expect(assembleDeltas(deltas)).toEqual(replayResult);
  });

  it("reports the missing request hash in replay mode", async () => {
    const replay = new CassetteProvider("replay", memoryStore());

    await expect(replay.complete(request, context)).rejects.toMatchObject({
      code: "cassette_miss",
      hash: requestHash(request),
    } satisfies Partial<CassetteMissError>);
  });

  it("reports a typed cassette miss when a request differs from the recorded request", async () => {
    const store = memoryStore();
    await store.set({ hash: requestHash(request), response: result });
    const replay = new CassetteProvider("replay", store);
    const mismatchedRequest = {
      ...request,
      model: { ...request.model, model: "different-model" },
    };

    await expect(replay.complete(mismatchedRequest, context)).rejects.toBeInstanceOf(
      CassetteMissError,
    );
    await expect(replay.complete(mismatchedRequest, context)).rejects.toMatchObject({
      code: "cassette_miss",
      hash: requestHash(mismatchedRequest),
    });
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

runProviderContract(
  "CassetteProvider record contract",
  (options, fixture) =>
    new CassetteProvider(
      "record",
      memoryStore(),
      contractFixtureProvider(options, fixture),
      contractPrivacyOptions,
    ),
  contractFixtures,
);

runProviderContract(
  "CassetteProvider replay contract",
  (_options, fixture) => {
    const store = memoryStore(fixture.scenario === "abort_signal" ? 200 : 0);
    const hash = requestHash(fixture.request);
    store.entries.set(hash, { hash, response: contractResult(fixture) });
    return new CassetteProvider("replay", store);
  },
  replayContractFixtures,
  {
    httpBacked: false,
    scenarios: ["text_only", "tool_call", "usage_mapping", "abort_signal"],
  },
);
