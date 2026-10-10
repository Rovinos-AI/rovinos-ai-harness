// SPDX-License-Identifier: Apache-2.0
import type { ModelRequest, Part } from "@harness/schemas";
import { describe, expect, it } from "vitest";
import { ProviderError } from "./errors.js";
import {
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
  return {
    scenario,
    request,
    httpResponse: { status, body: { response: "fixture" } },
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
      throw new ProviderError("provider_rate_limited", { status: response.status });
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
});

runProviderContract(
  "FakeProvider HTTP contract",
  (options, scenarioFixture) => new FakeHttpProvider(options, scenarioFixture),
  fixtures,
);
