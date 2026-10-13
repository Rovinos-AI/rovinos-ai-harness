// SPDX-License-Identifier: Apache-2.0
import { Sha256Hex, type Code, type Event, type ModelRequest } from "@harness/schemas";
import { describe, expect, it } from "vitest";
import type { ProviderContext } from "../types.js";
import {
  CassetteDivergenceError,
  CassetteLogIncompleteError,
  CassetteProvider,
  CassetteMissError,
  CassetteStoreReadOnlyError,
} from "./cassette-provider.js";
import { EventLogCassetteStore } from "./event-log-store.js";
import { requestHash } from "./hash.js";

const runId = "00000000000000000000000001";
const traceId = "a".repeat(32);
const spanId = "b".repeat(16);
const segmentId = "00000000000000000000000002";
const requestId = "00000000000000000000000003";
const request: ModelRequest = {
  requestId,
  model: { provider: "cassette", model: "test" },
  role: "assistant",
  messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }],
};
const context: ProviderContext = {
  signal: new AbortController().signal,
  ids: { next: () => "00000000000000000000000004" },
  clock: { now: () => 1 },
};

function requestEvent(
  seq: number,
  id: string,
  text: string,
  options: { readonly role?: Code; readonly provider?: string } = {},
): Event {
  const modelRequest: ModelRequest = {
    requestId: id,
    model: { provider: options.provider ?? "cassette", model: "test" },
    ...(options.role === undefined ? {} : { role: options.role }),
    messages: [{ role: "user", parts: [{ type: "text", text }] }],
  };
  return {
    runId,
    seq,
    ts: seq,
    v: 1,
    traceId,
    spanId,
    segmentId,
    type: "model_request",
    requestId: id,
    provider: options.provider ?? "cassette",
    model: "test",
    ...(options.role === undefined ? {} : { role: options.role }),
    requestHash: requestHash(modelRequest),
    messages: modelRequest.messages,
  };
}

function responseEvent(seq: number, id: string, text: string, costMicros?: number): Event {
  return {
    runId,
    seq,
    ts: seq,
    v: 1,
    traceId,
    spanId,
    segmentId,
    type: "model_response",
    requestId: id,
    provider: "cassette",
    model: "test",
    inputTokens: 2,
    outputTokens: 3,
    ...(costMicros === undefined ? {} : { costMicros }),
    finishReason: "stop",
    latencyMs: 5,
    schemaValid: true,
    repairAttempts: 0,
    fallbackDepth: 0,
    content: [{ type: "text", text }],
    providerBlobs: null,
  };
}

describe("EventLogCassetteStore", () => {
  it("serves paired responses in recorded order", async () => {
    const events = [
      requestEvent(0, requestId, "hello", { role: "assistant" }),
      responseEvent(1, requestId, "first"),
      requestEvent(2, "00000000000000000000000005", "next"),
      responseEvent(3, "00000000000000000000000005", "second", 9),
    ] satisfies Event[];
    const provider = new CassetteProvider("replay", new EventLogCassetteStore(events));

    expect((await provider.complete(request, context)).parts).toEqual([
      { type: "text", text: "first" },
    ]);
    expect(
      (
        await provider.complete(
          {
            requestId: "00000000000000000000000005",
            model: request.model,
            messages: [{ role: "user", parts: [{ type: "text", text: "next" }] }],
          },
          context,
        )
      ).usage,
    ).toEqual({ inputTokens: 2, outputTokens: 3, costMicros: 9 });
  });

  it("raises divergence and leaves the ordered cursor on the expected request", async () => {
    const events = [
      requestEvent(0, requestId, "hello", { role: "assistant" }),
      responseEvent(1, requestId, "first"),
    ] satisfies Event[];
    const store = new EventLogCassetteStore(events);
    const provider = new CassetteProvider("replay", store);
    const changed = {
      ...request,
      messages: [{ role: "user", parts: [{ type: "text", text: "changed" }] }],
    } satisfies ModelRequest;

    await expect(provider.complete(changed, context)).rejects.toMatchObject({
      code: "cassette_divergence",
    } satisfies Partial<CassetteDivergenceError>);
    expect((await provider.complete(request, context)).parts).toEqual([
      { type: "text", text: "first" },
    ]);
  });

  it("detects divergence in full request fields", async () => {
    const events = [
      requestEvent(0, requestId, "hello", {
        role: "assistant",
      }),
      responseEvent(1, requestId, "first"),
    ] satisfies Event[];
    const store = new EventLogCassetteStore(events);
    const variants: readonly ModelRequest[] = [
      { ...request, tools: [{ toolId: "lookup", description: "lookup", inputSchema: {} }] },
      { ...request, toolChoice: "none" },
      { ...request, maxOutputTokens: 10 },
      { ...request, temperature: 0.2 },
      {
        ...request,
        output: {
          name: "result",
          schema: {},
          schemaHash: Sha256Hex.parse("b".repeat(64)),
        },
      },
    ];

    for (const variant of variants) {
      await expect(store.get("a".repeat(64), variant)).rejects.toBeInstanceOf(
        CassetteDivergenceError,
      );
    }
    await expect(store.get("a".repeat(64), request)).resolves.toBeDefined();
  });

  it("pairs repeated request ids in log order", async () => {
    const provider = new CassetteProvider(
      "replay",
      new EventLogCassetteStore([
        requestEvent(0, requestId, "hello", { role: "assistant" }),
        responseEvent(1, requestId, "first"),
        requestEvent(2, requestId, "hello", { role: "assistant" }),
        responseEvent(3, requestId, "second"),
      ]),
    );

    expect((await provider.complete(request, context)).parts).toEqual([
      { type: "text", text: "first" },
    ]);
    expect((await provider.complete(request, context)).parts).toEqual([
      { type: "text", text: "second" },
    ]);
  });

  it("normalizes the recorded provider when replay routes through cassette", async () => {
    const store = new EventLogCassetteStore([
      requestEvent(0, requestId, "hello", { role: "assistant", provider: "openai" }),
      responseEvent(1, requestId, "recorded"),
    ]);

    await expect(store.get("a".repeat(64), request)).resolves.toMatchObject({
      parts: [{ type: "text", text: "recorded" }],
    });
  });

  it("rejects interrupted non-final requests and treats a final request as a miss", async () => {
    expect(
      () =>
        new EventLogCassetteStore([
          requestEvent(0, requestId, "interrupted"),
          requestEvent(1, "00000000000000000000000005", "later"),
          responseEvent(2, "00000000000000000000000005", "response"),
        ]),
    ).toThrow(CassetteLogIncompleteError);

    const finalRequestStore = new EventLogCassetteStore([requestEvent(0, requestId, "hello")]);
    await expect(finalRequestStore.get("a".repeat(64), request)).resolves.toBeUndefined();
    const provider = new CassetteProvider("replay", finalRequestStore);
    await expect(provider.complete(request, context)).rejects.toBeInstanceOf(CassetteMissError);
  });

  it("is read-only and returns a miss after the ordered responses are exhausted", async () => {
    const store = new EventLogCassetteStore([
      requestEvent(0, requestId, "hello", { role: "assistant" }),
      responseEvent(1, requestId, "first"),
    ]);
    const provider = new CassetteProvider("replay", store);
    await provider.complete(request, context);

    await expect(store.get(Sha256Hex.parse("a".repeat(64)), request)).resolves.toBeUndefined();
    await expect(
      store.set({
        hash: Sha256Hex.parse("a".repeat(64)),
        response: {
          parts: [],
          usage: { inputTokens: 0, outputTokens: 0 },
          finishReason: "stop",
          latencyMs: 0,
        },
      }),
    ).rejects.toBeInstanceOf(CassetteStoreReadOnlyError);
  });
});
