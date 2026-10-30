// SPDX-License-Identifier: Apache-2.0
import type { JsonValue, ModelRequest, Part } from "@rovinos/schemas";
import type { fetch as undiciFetch, RequestInit as UndiciRequestInit } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProviderContractFixtureSchema,
  runProviderContract,
  type ProviderContractAdapterOptions,
  type ProviderContractFixture,
} from "../contract.js";
import { ProviderError } from "../errors.js";
import { AzureOpenAIAdapter, type AzureOpenAICredential } from "./azure-openai.js";

const request: ModelRequest = {
  requestId: "00000000000000000000000000",
  model: { provider: "azure-fixture", model: "fixture-model" },
  messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }],
};

const textMessage = { role: "assistant", content: "answer" };
const toolMessage = {
  role: "assistant",
  content: null,
  tool_calls: [
    {
      id: "call_fixture",
      type: "function",
      function: { name: "lookup", arguments: '{"query":"x"}' },
    },
  ],
};

function completion(message: JsonValue, finishReason = "stop") {
  return {
    id: "azure-fixture-completion",
    object: "chat.completion",
    created: 1,
    model: "fixture-deployment",
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
  };
}

function fixtureStatus(scenario: ProviderContractFixture["scenario"]): number {
  switch (scenario) {
    case "error_429":
      return 429;
    case "error_500":
      return 500;
    case "error_401":
      return 401;
    case "abort_signal":
    case "text_only":
    case "tool_call":
    case "usage_mapping":
      return 200;
  }
}

function fixture(scenario: ProviderContractFixture["scenario"]): ProviderContractFixture {
  const isFailure =
    scenario === "error_429" || scenario === "error_500" || scenario === "error_401";
  const status = fixtureStatus(scenario);
  const message = scenario === "tool_call" ? toolMessage : textMessage;
  let expected: ProviderContractFixture["expected"];
  if (scenario === "text_only" || scenario === "tool_call") {
    const parts: Part[] = [];
    if (scenario === "tool_call") {
      parts.push({
        type: "tool_call",
        callId: request.requestId,
        toolId: "lookup",
        args: { query: "x" },
      });
    } else {
      parts.push({ type: "text", text: "answer" });
    }
    parts.push({
      type: "opaque",
      provider: request.model.provider,
      blob: {
        message,
        openaiCallIdByCallId:
          scenario === "tool_call" ? { [request.requestId]: "call_fixture" } : {},
      },
    });
    expected = {
      parts,
      usage: { inputTokens: 2, outputTokens: 3 },
      finishReason: scenario === "tool_call" ? "tool_calls" : "stop",
    };
  } else if (scenario === "usage_mapping") {
    expected = { usage: { inputTokens: 2, outputTokens: 3 }, finishReason: "stop" };
  } else if (scenario === "error_429") {
    expected = { retryAfterMs: 2_000, status };
  } else if (scenario === "error_500" || scenario === "error_401") {
    expected = { status };
  }
  return ProviderContractFixtureSchema.parse({
    scenario,
    request,
    httpResponse: {
      status,
      ...(scenario === "error_429" ? { headers: { "retry-after": "2" } } : {}),
      body: isFailure
        ? { error: { code: "fixture_error", message: "fixture failure" } }
        : {
            ...completion(message, scenario === "tool_call" ? "tool_calls" : "stop"),
            ...(scenario === "usage_mapping"
              ? { usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } }
              : {}),
          },
    },
    ...(expected === undefined ? {} : { expected }),
  });
}

const fixtures = [
  fixture("text_only"),
  fixture("tool_call"),
  fixture("usage_mapping"),
  fixture("error_429"),
  fixture("error_500"),
  fixture("error_401"),
  fixture("abort_signal"),
];

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

async function toWebResponse(response: Awaited<ReturnType<typeof undiciFetch>>): Promise<Response> {
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
  contractFixture: ProviderContractFixture,
): AzureOpenAIAdapter {
  return new AzureOpenAIAdapter({
    endpoint: options.baseUrl,
    apiVersion: "2024-10-21",
    deployments: { "fixture-model": "fixture-deployment" },
    provider: contractFixture.request.model.provider,
    auth: { kind: "api_key", apiKey: { reveal: () => "fixture-key" } },
    fetch: adaptFetch(options.fetch),
  });
}

runProviderContract("Azure OpenAI contract", contractAdapter, fixtures);

afterEach(() => {
  vi.unstubAllEnvs();
});

function testContext(now: () => number = () => 1_000): {
  readonly signal: AbortSignal;
  readonly ids: { next: () => string };
  readonly clock: { now: () => number };
} {
  return {
    signal: new AbortController().signal,
    ids: { next: () => request.requestId },
    clock: { now },
  };
}

function jsonResponse(body: JsonValue, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Azure OpenAI adapter", () => {
  it("uses the mapped deployment path, API version, and API-key header", async () => {
    let requestUrl = "";
    let apiKeyHeader: string | null = null;
    const adapter = new AzureOpenAIAdapter({
      endpoint: "https://resource.openai.azure.com",
      apiVersion: "2024-10-21",
      deployments: { "fixture-model": "deployment-name" },
      auth: { kind: "api_key", apiKey: { reveal: () => "fixture-key" } },
      fetch: (input, init) => {
        requestUrl = input instanceof Request ? input.url : input.toString();
        apiKeyHeader = new Headers(init?.headers).get("api-key");
        return Promise.resolve(jsonResponse(completion(textMessage)));
      },
    });

    await adapter.complete(request, testContext());

    const url = new URL(requestUrl);
    expect(url.pathname).toBe("/openai/deployments/deployment-name/chat/completions");
    expect(url.searchParams.get("api-version")).toBe("2024-10-21");
    expect(apiKeyHeader).toBe("fixture-key");
  });

  it("acquires, caches, and refreshes Entra tokens with the Cognitive Services scope", async () => {
    vi.stubEnv("OPENAI_BASE_URL", "https://unrelated.openai.example/v1");
    vi.stubEnv("AZURE_OPENAI_API_KEY", "ambient-key");
    let now = 1_000;
    let acquisitions = 0;
    const authorizationHeaders: string[] = [];
    const credential: AzureOpenAICredential = {
      getToken: (scope) => {
        expect(scope).toBe("https://cognitiveservices.azure.com/.default");
        acquisitions += 1;
        return Promise.resolve({
          token: `fixture-token-${acquisitions.toString()}`,
          expiresOnTimestamp: now + 3_600_000,
        });
      },
    };
    const adapter = new AzureOpenAIAdapter({
      endpoint: "https://resource.openai.azure.com",
      apiVersion: "2024-10-21",
      deployments: { "fixture-model": "deployment-name" },
      auth: { kind: "entra" },
      credential,
      clock: { now: () => now },
      fetch: (_input, init) => {
        const authorization = new Headers(init?.headers).get("authorization") ?? "";
        authorizationHeaders.push(authorization.startsWith("Bearer ") ? "present" : "missing");
        return Promise.resolve(jsonResponse(completion(textMessage)));
      },
    });

    await adapter.complete(
      request,
      testContext(() => now),
    );
    await adapter.complete(
      request,
      testContext(() => now),
    );
    now += 3_300_000;
    await adapter.complete(
      request,
      testContext(() => now),
    );

    expect(acquisitions).toBe(2);
    expect(authorizationHeaders).toEqual(["present", "present", "present"]);
  });

  it("shares an in-flight Entra token acquisition between requests", async () => {
    let acquisitions = 0;
    let resolveToken: ((token: { token: string; expiresOnTimestamp: number }) => void) | undefined;
    const token = new Promise<{ token: string; expiresOnTimestamp: number }>((resolve) => {
      resolveToken = resolve;
    });
    const adapter = new AzureOpenAIAdapter({
      endpoint: "https://resource.openai.azure.com",
      apiVersion: "2024-10-21",
      deployments: { "fixture-model": "deployment-name" },
      auth: { kind: "entra" },
      credential: {
        getToken: () => {
          acquisitions += 1;
          return token;
        },
      },
      fetch: () => Promise.resolve(jsonResponse(completion(textMessage))),
    });

    const first = adapter.complete(request, testContext());
    const second = adapter.complete(request, testContext());
    await vi.waitFor(() => {
      expect(acquisitions).toBe(1);
    });
    if (resolveToken === undefined) {
      throw new Error("Token acquisition did not start");
    }
    resolveToken({ token: "fixture-token", expiresOnTimestamp: Date.now() + 3_600_000 });
    await Promise.all([first, second]);
  });

  it.each([
    ["empty token", () => Promise.resolve(null)],
    ["credential failure", () => Promise.reject(new Error("synthetic credential failure"))],
  ])("maps Entra %s to a typed authentication error", async (_name, getToken) => {
    const adapter = new AzureOpenAIAdapter({
      endpoint: "https://resource.openai.azure.com",
      apiVersion: "2024-10-21",
      deployments: { "fixture-model": "deployment-name" },
      auth: { kind: "entra" },
      credential: { getToken },
      fetch: () => Promise.resolve(jsonResponse(completion(textMessage))),
    });

    await expect(adapter.complete(request, testContext())).rejects.toMatchObject({
      cause: { code: "provider_auth" },
    });
  });

  it("uses the system clock when no Entra clock is injected", async () => {
    const adapter = new AzureOpenAIAdapter({
      endpoint: "https://resource.openai.azure.com",
      apiVersion: "2024-10-21",
      deployments: { "fixture-model": "deployment-name" },
      auth: { kind: "entra" },
      credential: {
        getToken: () =>
          Promise.resolve({ token: "fixture-token", expiresOnTimestamp: Date.now() + 3_600_000 }),
      },
      fetch: () => Promise.resolve(jsonResponse(completion(textMessage))),
    });

    await expect(adapter.complete(request, testContext())).resolves.toMatchObject({
      finishReason: "stop",
    });
  });

  it("maps Azure content-filter API errors and finish reasons to a typed error", async () => {
    const filteredError = new AzureOpenAIAdapter({
      endpoint: "https://resource.openai.azure.com",
      apiVersion: "2024-10-21",
      deployments: { "fixture-model": "deployment-name" },
      auth: { kind: "api_key", apiKey: { reveal: () => "fixture-key" } },
      fetch: () =>
        Promise.resolve(
          jsonResponse({ error: { code: "content_filter", message: "filtered" } }, 400),
        ),
    });
    await expect(filteredError.complete(request, testContext())).rejects.toMatchObject({
      code: "provider_content_filtered",
    });

    const filteredResponse = new AzureOpenAIAdapter({
      endpoint: "https://resource.openai.azure.com",
      apiVersion: "2024-10-21",
      deployments: { "fixture-model": "deployment-name" },
      auth: { kind: "api_key", apiKey: { reveal: () => "fixture-key" } },
      fetch: () => Promise.resolve(jsonResponse(completion(textMessage, "content_filter"))),
    });
    const error = await filteredResponse
      .complete(request, testContext())
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ code: "provider_content_filtered" });
  });

  it("streams Azure responses and maps content-filter finish reasons", async () => {
    const adapterFor = (finishReason: string) =>
      new AzureOpenAIAdapter({
        endpoint: "https://resource.openai.azure.com",
        apiVersion: "2024-10-21",
        deployments: { "fixture-model": "deployment-name" },
        auth: { kind: "api_key", apiKey: { reveal: () => "fixture-key" } },
        fetch: () =>
          Promise.resolve(
            new Response(
              `data: ${JSON.stringify({
                id: "azure-stream",
                object: "chat.completion.chunk",
                created: 1,
                model: "fixture-deployment",
                choices: [{ index: 0, delta: { content: "answer" }, finish_reason: finishReason }],
              })}\n\ndata: [DONE]\n\n`,
              { headers: { "content-type": "text/event-stream" } },
            ),
          ),
      });

    let deltaCount = 0;
    for await (const delta of adapterFor("stop").stream(request, testContext())) {
      expect(delta.type).toBeDefined();
      deltaCount += 1;
    }
    expect(deltaCount).toBeGreaterThan(0);

    const filteredDeltas = adapterFor("content_filter").stream(request, testContext());
    await expect(async () => {
      for await (const delta of filteredDeltas) {
        expect(delta.type).toBeDefined();
      }
    }).rejects.toMatchObject({ code: "provider_content_filtered" });
  });

  it("rejects requests without a configured logical deployment", async () => {
    const adapter = new AzureOpenAIAdapter({
      endpoint: "https://resource.openai.azure.com",
      apiVersion: "2024-10-21",
      deployments: { "other-model": "deployment-name" },
      auth: { kind: "api_key", apiKey: { reveal: () => "fixture-key" } },
    });

    await expect(adapter.complete(request, testContext())).rejects.toMatchObject({
      code: "provider_bad_request",
    });
  });
});
