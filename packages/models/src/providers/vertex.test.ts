// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import type { GoogleGenAIOptions } from "@google/genai";
import { JWT } from "google-auth-library";
import { JsonValue, parseJson } from "@harness/schemas";
import type { ModelRequest } from "@harness/schemas";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ProviderContractFixtureSchema,
  runProviderContract,
  type ProviderContractAdapterOptions,
} from "../contract.js";
import { ProviderError } from "../errors.js";
import { ModelGateway } from "../gateway.js";
import { AdapterRegistry } from "../registry.js";
import { VertexAdapter } from "./vertex.js";

const requestId = "00000000000000000000000000";
const secondCallId = "11111111111111111111111111";
const baseRequest: ModelRequest = {
  requestId,
  model: { provider: "vertex", model: "gemini-test" },
  messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }],
};
type VertexFetch = NonNullable<NonNullable<GoogleGenAIOptions["httpOptions"]>["fetch"]>;
const fixtures = parseJson(
  z.array(ProviderContractFixtureSchema),
  readFileSync(new URL("./__fixtures__/vertex/contract.json", import.meta.url), "utf8"),
);

function testAuthOptions(): GoogleGenAIOptions["googleAuthOptions"] {
  const authClient = new JWT({
    email: "synthetic-vertex@example.test",
    key: "synthetic-test-key",
  });
  authClient.getRequestHeaders = async () =>
    new Headers({ authorization: "******" });
  return { authClient };
}

function abortableFetch<T>(pending: Promise<T>, signal: AbortSignal | null | undefined): Promise<T> {
  if (signal === undefined || signal === null) {
    return pending;
  }
  return new Promise<T>((resolve, reject) => {
    const removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      removeAbortListener();
      reject(new DOMException("The request was aborted.", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
    pending.then(
      (value) => {
        removeAbortListener();
        resolve(value);
      },
      (error: unknown) => {
        removeAbortListener();
        reject(error);
      },
    );
  });
}

function sdkFetch(
  fetch: ProviderContractAdapterOptions["fetch"],
  ignoreTransportAbort = false,
): VertexFetch {
  return async (input, init) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const pending = fetch(url, {
      ...(init?.method === undefined ? {} : { method: init.method }),
      ...(init?.headers === undefined
        ? {}
        : { headers: Object.fromEntries(new Headers(init.headers)) }),
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
      ...(!ignoreTransportAbort && init?.signal !== undefined ? { signal: init.signal } : {}),
    });
    const response = await abortableFetch(pending, init?.signal);
    return new Response(await response.text(), {
      status: response.status,
      headers: Object.fromEntries(response.headers),
    });
  };
}

function contractAdapter(
  options: ProviderContractAdapterOptions,
  fixture: (typeof fixtures)[number],
): VertexAdapter {
  return new VertexAdapter({
    project: "fixture-project",
    location: "us-central1",
    httpOptions: {
      baseUrl: options.baseUrl,
      apiVersion: "v1",
      fetch: sdkFetch(options.fetch, fixture.scenario === "abort_signal"),
      retryOptions: { attempts: 5 },
    },
    googleAuthOptions: testAuthOptions(),
  });
}

function context(
  signal = new AbortController().signal,
  callIds: readonly string[] = [requestId],
) {
  let now = 0;
  let nextCallId = 0;
  return {
    signal,
    ids: { next: () => callIds[nextCallId++] ?? requestId },
    clock: {
      now: () => {
        now += 3;
        return now;
      },
    },
  };
}

function mockedAdapter(
  body: unknown,
  status = 200,
  headers: HeadersInit = {},
  fetchOverride?: VertexFetch,
): {
  readonly adapter: VertexAdapter;
  readonly requests: () => JsonValue[];
} {
  const requests: JsonValue[] = [];
  const fetch: VertexFetch = fetchOverride ?? (async (_input, init) => {
    if (typeof init?.body === "string") {
      requests.push(parseJson(JsonValue, init.body));
    }
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...Object.fromEntries(new Headers(headers)) },
    });
  });
  return {
    adapter: new VertexAdapter({
      project: "fixture-project",
      location: "us-central1",
      httpOptions: {
        baseUrl: "https://vertex.test",
        apiVersion: "v1",
        fetch,
        retryOptions: { attempts: 5 },
      },
      googleAuthOptions: testAuthOptions(),
    }),
    requests: () => requests,
  };
}

describe("Vertex AI adapter", () => {
  it("uses native response schemas and function calling while recording dropped schema keywords", async () => {
    const mock = mockedAdapter({
      candidates: [
        {
          content: { role: "model", parts: [{ text: '{"name":"answer"}' }] },
          finishReason: "STOP",
        },
      ],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4, thoughtsTokenCount: 5 },
    });
    const request: ModelRequest = {
      ...baseRequest,
      messages: [
        { role: "system", parts: [{ type: "text", text: "Be concise." }] },
        ...baseRequest.messages,
      ],
      tools: [
        {
          toolId: "lookup",
          description: "Find a record",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string", pattern: "^[a-z]+$" } },
          },
        },
      ],
      toolChoice: { forced: "lookup" },
      output: {
        name: "answer",
        schema: {
          type: "object",
          properties: { name: { type: "string", pattern: "^[a-z]+$" } },
          required: ["name"],
        },
        schemaHash: "a".repeat(64),
      },
    };

    const result = await mock.adapter.complete(request, context());
    const sent = mock.requests()[0];

    expect(sent).toMatchObject({
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
      systemInstruction: { parts: [{ text: "Be concise." }] },
      generationConfig: {
        maxOutputTokens: 4_096,
        responseMimeType: "application/json",
        responseJsonSchema: { type: "object", properties: { name: { type: "string" } } },
      },
      tools: [
        {
          functionDeclarations: [
            { name: "lookup", parametersJsonSchema: { type: "object" } },
          ],
        },
      ],
      toolConfig: {
        functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["lookup"] },
      },
    });
    expect(result.parts.at(-1)).toMatchObject({
      type: "opaque",
      blob: { droppedSchemaKeywords: ["pattern"] },
    });
    expect(result.usage.outputTokens).toBe(9);
  }, 15_000);

  it("rehydrates the raw thought signature and links tool results to the original call id", async () => {
    const initialContent = {
      role: "model",
      parts: [
        {
          functionCall: { id: "provider-call-1", name: "lookup", args: { query: "x" } },
          thoughtSignature: "opaque-signature-canary",
        },
      ],
    };
    const mock = mockedAdapter({
      candidates: [{ content: initialContent, finishReason: "STOP" }],
    });
    const first = await mock.adapter.complete(baseRequest, context());
    const opaque = first.parts.find((part) => part.type === "opaque");
    if (opaque?.type !== "opaque") {
      throw new Error("Expected the raw provider part to be preserved.");
    }
    const secondRequest: ModelRequest = {
      ...baseRequest,
      messages: [
        ...baseRequest.messages,
        { role: "assistant", parts: first.parts },
        {
          role: "tool",
          parts: [{ type: "tool_result", callId: requestId, result: { count: 1 }, isError: false }],
        },
      ],
    };

    await mock.adapter.complete(secondRequest, context());
    const sent = mock.requests()[1];

    expect(opaque.blob).toMatchObject({
      content: initialContent,
      functionCalls: { [requestId]: { id: "provider-call-1", name: "lookup" } },
    });
    expect(sent).toMatchObject({
      contents: [
        { role: "user", parts: [{ text: "hello" }] },
        { role: "model", parts: initialContent.parts },
        {
          role: "user",
          parts: [
            {
              functionResponse: {
                id: "provider-call-1",
                name: "lookup",
                response: { count: 1 },
              },
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(sent)).toContain("opaque-signature-canary");
  }, 15_000);

  it("rebuilds assistant content from normalized parts when the opaque text was transformed", async () => {
    const rawText = "alice@example.test";
    const mock = mockedAdapter({
      candidates: [
        {
          content: {
            role: "model",
            parts: [{ text: rawText }, { thoughtSignature: "signature-canary" }],
          },
          finishReason: "STOP",
        },
      ],
    });
    const first = await mock.adapter.complete(baseRequest, context());
    const secondRequest: ModelRequest = {
      ...baseRequest,
      messages: [
        ...baseRequest.messages,
        {
          role: "assistant",
          parts: first.parts.map((part) =>
            part.type === "text" ? { ...part, text: "EMAIL_0001" } : part,
          ),
        },
      ],
    };

    await mock.adapter.complete(secondRequest, context());
    const sent = mock.requests()[1];

    expect(sent).toMatchObject({
      contents: [
        { role: "user", parts: [{ text: "hello" }] },
        { role: "model", parts: [{ text: "EMAIL_0001" }] },
      ],
    });
    expect(JSON.stringify(sent)).not.toContain(rawText);
  });

  it("round-trips parallel calls with consecutive tool results in one user turn", async () => {
    const initialContent = {
      role: "model",
      parts: [
        { functionCall: { id: "provider-call-1", name: "lookup", args: { query: "a" } } },
        { functionCall: { id: "provider-call-2", name: "lookup", args: { query: "b" } } },
      ],
    };
    const mock = mockedAdapter({
      candidates: [{ content: initialContent, finishReason: "STOP" }],
    });
    const first = await mock.adapter.complete(
      baseRequest,
      context(new AbortController().signal, [requestId, secondCallId]),
    );
    const secondRequest: ModelRequest = {
      ...baseRequest,
      messages: [
        ...baseRequest.messages,
        { role: "assistant", parts: first.parts },
        {
          role: "tool",
          parts: [{ type: "tool_result", callId: requestId, result: { result: "a" }, isError: false }],
        },
        {
          role: "tool",
          parts: [
            { type: "tool_result", callId: secondCallId, result: { result: "b" }, isError: false },
          ],
        },
      ],
    };

    await mock.adapter.complete(secondRequest, context());
    const sent = mock.requests()[1];

    expect(sent).toMatchObject({
      contents: [
        { role: "user", parts: [{ text: "hello" }] },
        { role: "model", parts: initialContent.parts },
        {
          role: "user",
          parts: [
            { functionResponse: { id: "provider-call-1", name: "lookup", response: { result: "a" } } },
            { functionResponse: { id: "provider-call-2", name: "lookup", response: { result: "b" } } },
          ],
        },
      ],
    });
    expect(first.finishReason).toBe("tool_calls");
  });

  it.each([
    ["SAFETY", "provider_content_filtered"],
    ["RECITATION", "provider_content_filtered"],
    ["BLOCKLIST", "provider_content_filtered"],
    ["PROHIBITED_CONTENT", "provider_content_filtered"],
    ["SPII", "provider_content_filtered"],
    ["IMAGE_SAFETY", "provider_content_filtered"],
    ["MAX_TOKENS", "length"],
    ["MALFORMED_FUNCTION_CALL", "tool_args_invalid"],
    ["UNEXPECTED_TOOL_CALL", "other"],
    ["UNSPECIFIED", "other"],
  ])("maps finish reason %s", async (finishReason, expected) => {
    const mock = mockedAdapter({
      candidates: [
        { content: { role: "model", parts: [] }, finishReason },
      ],
    });
    const result = await mock.adapter.complete(baseRequest, context());

    expect(result.finishReason).toBe(expected);
  });

  it("maps prompt-level safety blocks to the filtered taxonomy", async () => {
    const mock = mockedAdapter({
      promptFeedback: { blockReason: "SAFETY", blockReasonMessage: "safety-canary" },
      candidates: [],
    });
    const result = await mock.adapter.complete(baseRequest, context());

    expect(result.finishReason).toBe("provider_content_filtered");
    expect(JSON.stringify(result)).not.toContain("safety-canary");
  });

  it.each([
    [429, "provider_rate_limited"],
    [403, "provider_auth"],
    [400, "provider_bad_request"],
    [404, "provider_bad_request"],
    [408, "provider_timeout"],
    [500, "provider_unavailable"],
    [502, "provider_unavailable"],
    [503, "provider_unavailable"],
  ])("maps HTTP %i without preserving response messages", async (status, code) => {
    const mock = mockedAdapter(
      { error: { code: status, status: "FAILED", message: "provider-error-canary" } },
      status,
    );
    const error = await mock.adapter.complete(baseRequest, context()).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ code, status });
    expect(String(error)).not.toContain("provider-error-canary");
  });

  it("maps safety HTTP errors and keeps their bodies out of ProviderError", async () => {
    const mock = mockedAdapter(
      { error: { code: 400, details: [{ reason: "PROHIBITED_CONTENT" }], message: "safety-canary" } },
      400,
    );
    const error = await mock.adapter.complete(baseRequest, context()).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "provider_content_filtered", status: 400 });
    expect(JSON.stringify(error)).not.toContain("safety-canary");
  });

  it("maps Retry-After and RetryInfo to a safe retry delay", async () => {
    const headerMock = mockedAdapter(
      { error: { code: 429, message: "quota-canary" } },
      429,
      { "retry-after": "2" },
    );
    const headerError = await headerMock.adapter
      .complete(baseRequest, context())
      .catch((caught: unknown) => caught);
    expect(headerError).toMatchObject({ code: "provider_rate_limited", retryAfterMs: 2_000 });

    const bodyMock = mockedAdapter(
      {
        error: {
          code: 429,
          details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "1.5s" }],
          message: "quota-canary",
        },
      },
      429,
    );
    const bodyError = await bodyMock.adapter
      .complete(baseRequest, context())
      .catch((caught: unknown) => caught);
    expect(bodyError).toMatchObject({ code: "provider_rate_limited", retryAfterMs: 1_500 });
    expect(JSON.stringify(bodyError)).not.toContain("quota-canary");
  });

  it.each([
    [new TypeError("fetch failed", { cause: { code: "ECONNRESET" } }), "provider_unavailable"],
    [new Error("Could not load the default credentials."), "provider_auth"],
  ])("maps non-HTTP failures without leaking their message", async (failure, code) => {
    const failedFetch: VertexFetch = async () => {
      throw failure;
    };
    const mock = mockedAdapter({}, 200, {}, failedFetch);
    const error = await mock.adapter.complete(baseRequest, context()).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code });
    expect(JSON.stringify(error)).not.toContain(failure.message);
  });

  it.each([
    { field: "project", options: { project: "bad project", location: "us-central1" } },
    { field: "location", options: { project: "fixture-project", location: "US-CENTRAL1" } },
    {
      field: "baseUrl",
      options: {
        project: "fixture-project",
        location: "us-central1",
        httpOptions: { baseUrl: "http://vertex.test" },
      },
    },
  ])("rejects unsafe adapter options ($field)", ({ options }) => {
    expect(() => new VertexAdapter(options)).toThrow();
  });

  it.each([
    [{ toolChoice: "none" as const, tools: [{ toolId: "lookup", description: "", inputSchema: {} }] }, false],
    [{ toolChoice: "auto" as const, tools: [] }, false],
    [{ toolChoice: "auto" as const, tools: [{ toolId: "lookup", description: "", inputSchema: {} }] }, true],
    [
      {
        toolChoice: { forced: "lookup" },
        tools: [{ toolId: "lookup", description: "", inputSchema: {} }],
      },
      true,
    ],
  ])("includes tool config only when callable tools are present", async (fields, hasTools) => {
    const mock = mockedAdapter({ candidates: [{ content: { role: "model", parts: [] } }] });

    await mock.adapter.complete({ ...baseRequest, ...fields }, context());

    const sent = mock.requests()[0];
    if (hasTools) {
      expect(sent).toHaveProperty("tools", expect.any(Array));
      expect(sent).toHaveProperty("toolConfig", expect.any(Object));
      expect(sent).toHaveProperty(
        "toolConfig.functionCallingConfig.mode",
        fields.toolChoice === "auto" ? "AUTO" : "ANY",
      );
    } else {
      expect(sent).not.toHaveProperty("tools");
      expect(sent).not.toHaveProperty("toolConfig");
    }
  });

  it("rejects a forced tool that is not declared before sending a request", async () => {
    const mock = mockedAdapter({ candidates: [] });

    const error = await mock.adapter
      .complete(
        {
          ...baseRequest,
          toolChoice: { forced: "missing" },
          tools: [{ toolId: "lookup", description: "", inputSchema: {} }],
        },
        context(),
      )
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "provider_bad_request" });
    expect(mock.requests()).toHaveLength(0);
  });

  it("preserves schema drops and uses native structured output through the gateway by default", async () => {
    const mock = mockedAdapter({
      candidates: [
        {
          content: { role: "model", parts: [{ text: '{"answer":"valid"}' }] },
          finishReason: "STOP",
        },
      ],
    });
    const gateway = new ModelGateway(new AdapterRegistry([mock.adapter]), {
      ids: { next: () => requestId },
      clock: { now: () => 0 },
    });

    const response = await gateway.complete(baseRequest, {
      runId: requestId,
      signal: new AbortController().signal,
      outputSchema: z.object({ answer: z.string().regex(/^valid$/) }),
    });

    expect(mock.requests()[0]).toMatchObject({
      generationConfig: { responseJsonSchema: { type: "object", properties: { answer: { type: "string" } } } },
    });
    expect(response.parts.at(-1)).toMatchObject({
      type: "opaque",
      blob: { droppedSchemaKeywords: ["pattern"] },
    });
  });

  it("rejects malformed opaque parts before sending a request", async () => {
    const mock = mockedAdapter({ candidates: [] });
    const request: ModelRequest = {
      ...baseRequest,
      messages: [
        ...baseRequest.messages,
        { role: "assistant", parts: [{ type: "opaque", provider: "vertex", blob: {} }] },
      ],
    };

    const error = await mock.adapter.complete(request, context()).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "provider_bad_request" });
    expect(mock.requests()).toHaveLength(0);
  });

  it("rejects a tool result without a matching earlier function call", async () => {
    const mock = mockedAdapter({ candidates: [] });
    const request: ModelRequest = {
      ...baseRequest,
      messages: [
        ...baseRequest.messages,
        {
          role: "tool",
          parts: [{ type: "tool_result", callId: requestId, result: {}, isError: false }],
        },
      ],
    };

    const error = await mock.adapter.complete(request, context()).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "provider_bad_request" });
    expect(mock.requests()).toHaveLength(0);
  });

  it("maps failed tool results as function errors", async () => {
    const mock = mockedAdapter({ candidates: [] });
    const request: ModelRequest = {
      ...baseRequest,
      messages: [
        ...baseRequest.messages,
        {
          role: "assistant",
          parts: [{ type: "tool_call", callId: requestId, toolId: "lookup", args: {} }],
        },
        {
          role: "tool",
          parts: [
            {
              type: "tool_result",
              callId: requestId,
              result: { reason: "synthetic-error" },
              isError: true,
            },
          ],
        },
      ],
    };

    await mock.adapter.complete(request, context());

    expect(mock.requests()[0]).toMatchObject({
      contents: [
        { role: "user", parts: [{ text: "hello" }] },
        { role: "model", parts: [{ functionCall: { name: "lookup", args: {} } }] },
        {
          role: "user",
          parts: [
            {
              functionResponse: {
                name: "lookup",
                response: { error: { reason: "synthetic-error" } },
              },
            },
          ],
        },
      ],
    });
  });

  it("keeps malformed function calls opaque instead of exposing invalid tool arguments", async () => {
    const mock = mockedAdapter({
      candidates: [
        {
          content: { role: "model", parts: [{ functionCall: { name: "Invalid Name", args: {} } }] },
          finishReason: "STOP",
        },
      ],
    });

    const error = await mock.adapter.complete(baseRequest, context()).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "provider_unknown" });
  });
});

runProviderContract("Vertex AI Gemini contract", contractAdapter, fixtures);
