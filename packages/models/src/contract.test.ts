// SPDX-License-Identifier: Apache-2.0
import type { ModelRequest, Part } from "@rovinos/schemas";
import { describe, expect, it } from "vitest";
import { ProviderError } from "./errors.js";
import {
  assertAbortCompletion,
  runProviderContract,
  type ProviderContractAdapterOptions,
  type ProviderContractFixture,
} from "./contract.js";
import { FakeProvider } from "./testing/fake-provider.js";
import type { ProviderAdapter, ProviderContext, ProviderResult } from "./types.js";

const id = "00000000000000000000000000";
const request: ModelRequest = {
  requestId: id,
  model: { provider: "fake", model: "model-a" },
  messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }],
};

function fixture(
  scenario: ProviderContractFixture["scenario"],
  status: number,
): ProviderContractFixture {
  const textParts: Part[] = [{ type: "text", text: "answer" }];
  const toolParts: Part[] = [{ type: "tool_call", callId: id, toolId: "tool", args: {} }];
  let expected: ProviderContractFixture["expected"];
  switch (scenario) {
    case "text_only":
      expected = {
        parts: textParts,
        usage: { inputTokens: 2, outputTokens: 3 },
        finishReason: "stop",
      };
      break;
    case "tool_call":
      expected = {
        parts: toolParts,
        usage: { inputTokens: 2, outputTokens: 3 },
        finishReason: "stop",
      };
      break;
    case "usage_mapping":
      expected = { usage: { inputTokens: 2, outputTokens: 3 }, finishReason: "stop" };
      break;
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
  }

  return {
    scenario,
    request,
    httpResponse: {
      status,
      ...(scenario === "error_429" ? { headers: { "retry-after": "2" } } : {}),
      body: { response: "fixture" },
    },
    ...(expected === undefined ? {} : { expected }),
  };
}

function result(parts: Part[], usage = { inputTokens: 2, outputTokens: 3 }): ProviderResult {
  return { parts, usage, finishReason: "stop", latencyMs: 1 };
}

class FakeHttpProvider implements ProviderAdapter {
  private readonly fake: FakeProvider;

  constructor(
    private readonly options: ProviderContractAdapterOptions,
    fixtureForResult: ProviderContractFixture,
  ) {
    const parts: Part[] =
      fixtureForResult.scenario === "tool_call"
        ? [{ type: "tool_call", callId: id, toolId: "tool", args: {} }]
        : [{ type: "text", text: "answer" }];
    this.fake = new FakeProvider("fake", [result(parts)]);
  }

  readonly provider = "fake";
  readonly kind = "openai" as const;

  async complete(
    requestToComplete: ModelRequest,
    context: ProviderContext,
  ): Promise<ProviderResult> {
    const response = await this.options.fetch(`${this.options.baseUrl}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestToComplete),
      signal: context.signal,
    });
    if (response.status === 429) {
      const retryAfter = response.headers.get("retry-after");
      throw new ProviderError("provider_rate_limited", {
        status: response.status,
        ...(retryAfter === null ? {} : { retryAfterMs: Number(retryAfter) * 1_000 }),
      });
    }
    if (response.status >= 500) {
      throw new ProviderError("provider_unavailable", { status: response.status });
    }
    if (response.status === 401) {
      throw new ProviderError("provider_auth", { status: response.status });
    }
    return this.fake.complete(requestToComplete, context);
  }
}

const fixtures = [
  fixture("text_only", 200),
  fixture("tool_call", 200),
  fixture("usage_mapping", 200),
  fixture("error_429", 429),
  fixture("error_500", 500),
  fixture("error_401", 401),
  fixture("abort_signal", 200),
];

describe("provider contract fixture format", () => {
  it("measures synchronous abort-listener time in the cancellation bound", async () => {
    const controller = new AbortController();
    controller.signal.addEventListener("abort", () => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 110);
    });
    let rejectCompletion: ((reason: ProviderError) => void) | undefined;
    const completion = new Promise<never>((_resolve, reject) => {
      rejectCompletion = reject;
    });
    controller.signal.addEventListener("abort", () => {
      rejectCompletion?.(new ProviderError("provider_timeout"));
    });

    await expect(assertAbortCompletion(completion, controller, () => true)).rejects.toThrow();
  });

  it("accepts and rejects the complete fixture contract", async () => {
    const { ProviderContractFixtureSchema } = await import("./contract.js");

    expect(ProviderContractFixtureSchema.parse(fixtures[0])).toEqual(fixtures[0]);
    expect(
      ProviderContractFixtureSchema.safeParse({
        scenario: "text_only",
        request,
        httpResponse: { status: 700, body: {} },
      }).success,
    ).toBe(false);
  });

  it("requires every contract scenario exactly once", () => {
    expect(() => {
      runProviderContract(
        "missing scenario",
        () => {
          throw new Error("The adapter factory should not be called.");
        },
        fixtures.slice(1),
      );
    }).toThrow("Provider contract fixtures are missing");
    expect(() => {
      runProviderContract(
        "duplicate scenario",
        () => {
          throw new Error("The adapter factory should not be called.");
        },
        [...fixtures, fixture("text_only", 200)],
      );
    }).toThrow("must not contain duplicate");
  });
});

runProviderContract(
  "FakeProvider HTTP contract",
  (options, scenarioFixture) => new FakeHttpProvider(options, scenarioFixture),
  fixtures,
);
