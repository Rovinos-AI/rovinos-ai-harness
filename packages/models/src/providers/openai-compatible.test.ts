// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { parseJson, type ModelRequest } from "@rovinos/schemas";
import type { fetch as undiciFetch, RequestInit as UndiciRequestInit } from "undici";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ProviderContractFixtureSchema,
  runProviderContract,
  type ProviderContractAdapterOptions,
  type ProviderContractFixture,
} from "../contract.js";
import { AdapterRegistry } from "../registry.js";
import { toChatRequest } from "./chat-completions-mapper.js";
import { OpenAICompatibleAdapter } from "./openai-compatible.js";

const fixtures = parseJson(
  z.array(ProviderContractFixtureSchema),
  readFileSync(new URL("./__fixtures__/openai-compatible/contract.json", import.meta.url), "utf8"),
);

function toUndiciRequestInit(init: RequestInit | undefined): UndiciRequestInit {
  return {
    ...(init?.method === undefined ? {} : { method: init.method }),
    ...(init?.headers === undefined
      ? {}
      : { headers: Object.fromEntries(new Headers(init.headers).entries()) }),
    ...(typeof init?.body === "string" ? { body: init.body } : {}),
    ...(init?.signal === undefined ? {} : { signal: init.signal }),
  };
}

async function toWebResponse(
  response: Awaited<ReturnType<typeof undiciFetch>>,
): Promise<Response> {
  const headers = new Headers();
  response.headers.forEach((value, name) => {
    headers.append(name, value);
  });
  return new Response(await response.arrayBuffer(), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function adaptFetch(fetchRequest: typeof undiciFetch): typeof fetch {
  return async (input, init) => {
    const response = await fetchRequest(
      input instanceof Request ? input.url : input.toString(),
      toUndiciRequestInit(init),
    );
    return toWebResponse(response);
  };
}

function contractAdapter(
  options: ProviderContractAdapterOptions,
  fixture: ProviderContractFixture,
): OpenAICompatibleAdapter {
  return new OpenAICompatibleAdapter({
    provider: fixture.request.model.provider,
    apiKey: { reveal: () => "fixture-key" },
    baseURL: options.baseUrl,
    trust: "local",
    fetch: adaptFetch(options.fetch),
  });
}

runProviderContract("OpenAI-compatible endpoint contract", contractAdapter, fixtures);

describe("OpenAI-compatible adapter", () => {
  const request: ModelRequest = {
    requestId: "00000000000000000000000000",
    model: { provider: "local-endpoint", model: "fixture-model" },
    messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }],
  };

  it("uses configured token and strict-schema quirks", () => {
    const mapped = toChatRequest(
      {
        ...request,
        maxOutputTokens: 16,
        output: {
          name: "answer",
          schema: { type: "object", properties: { answer: { type: "string" } } },
          schemaHash: "a".repeat(64),
        },
      },
      {
        structuredOutput: "native",
        parallelToolCalls: false,
        useMaxTokens: true,
        supportsStrictSchema: false,
      },
      "local-endpoint",
    );

    expect(Reflect.get(mapped, "max_tokens")).toBe(16);
    expect(mapped.max_completion_tokens).toBeUndefined();
    expect(mapped.response_format).toEqual({
      type: "json_schema",
      json_schema: {
        name: "answer",
        schema: { type: "object", properties: { answer: { type: "string" } } },
        strict: false,
      },
    });
  });

  it("retains provider trust through the adapter registry", () => {
    const adapter = new OpenAICompatibleAdapter({
      provider: request.model.provider,
      baseURL: "http://localhost:11434/v1",
      trust: "local",
    });

    expect(adapter.kind).toBe("openai_compatible");
    expect(new AdapterRegistry([adapter]).get(request.model.provider).trust).toBe("local");
  });

  it("rejects an untrusted plain-HTTP remote endpoint", () => {
    expect(
      () =>
        new OpenAICompatibleAdapter({
          provider: request.model.provider,
          baseURL: "http://model.example.test/v1",
        }),
    ).toThrow();
    expect(
      () =>
        new OpenAICompatibleAdapter({
          provider: request.model.provider,
          baseURL: "http://model.example.test/v1",
          trust: "local",
        }),
    ).not.toThrow();
  });
});
