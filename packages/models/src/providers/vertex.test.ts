// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import type { GoogleGenAIOptions } from "@google/genai";
import { OAuth2Client } from "google-auth-library";
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
import { VertexAdapter } from "./vertex.js";

const requestId = "00000000000000000000000000";
const baseRequest: ModelRequest = {
  requestId,
  model: { provider: "vertex", model: "gemini-test" },
  messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }],
};
const fixtures = parseJson(
  z.array(ProviderContractFixtureSchema),
  readFileSync(new URL("./__fixtures__/vertex/contract.json", import.meta.url), "utf8"),
);

function testAuthOptions(): GoogleGenAIOptions["googleAuthOptions"] {
  const authClient = new OAuth2Client();
  authClient.setCredentials({ access_token: "synthetic-test-token" });
  return { authClient };
}

function sdkFetch(
  fetch: ProviderContractAdapterOptions["fetch"],
): NonNullable<GoogleGenAIOptions["httpOptions"]>["fetch"] {
  return async (input, init) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const response = await fetch(url, {
      ...(init?.method === undefined ? {} : { method: init.method }),
      ...(init?.headers === undefined
        ? {}
        : { headers: Object.fromEntries(new Headers(init.headers)) }),
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
      ...(init?.signal === undefined ? {} : { signal: init.signal }),
    });
    return new Response(await response.text(), {
      status: response.status,
      headers: Object.fromEntries(response.headers),
    });
  };
}

function contractAdapter(options: ProviderContractAdapterOptions): VertexAdapter {
  return new VertexAdapter({
    project: "fixture-project",
    location: "us-central1",
    httpOptions: {
      baseUrl: options.baseUrl,
      apiVersion: "v1",
      fetch: sdkFetch(options.fetch),
      retryOptions: { attempts: 5 },
    },
    googleAuthOptions: testAuthOptions(),
  });
}

function context(signal = new AbortController().signal) {
  let now = 0;
  return {
    signal,
    ids: { next: () => requestId },
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
): {
  readonly adapter: VertexAdapter;
  readonly requests: () => JsonValue[];
} {
  const requests: JsonValue[] = [];
  const fetch: NonNullable<GoogleGenAIOptions["httpOptions"]>["fetch"] = async (_input, init) => {
    if (typeof init?.body === "string") {
      requests.push(parseJson(JsonValue, init.body));
    }
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
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
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4 },
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

  it.each([
    ["SAFETY", "provider_content_filtered"],
    ["RECITATION", "provider_content_filtered"],
    ["MAX_TOKENS", "length"],
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
    [408, "provider_timeout"],
    [500, "provider_unavailable"],
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
