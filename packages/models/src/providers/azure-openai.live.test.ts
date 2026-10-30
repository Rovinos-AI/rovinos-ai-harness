// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { AzureOpenAIAdapter } from "./azure-openai.js";

const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
const apiKey = process.env.AZURE_OPENAI_API_KEY;
const apiVersion = process.env.AZURE_OPENAI_API_VERSION;
const deployment = process.env.AZURE_OPENAI_DEPLOYMENT;

describe.skipIf(
  endpoint === undefined ||
    apiKey === undefined ||
    apiVersion === undefined ||
    deployment === undefined,
)("LIVE Azure OpenAI adapter", () => {
  it("completes a request against the configured deployment", async () => {
    const adapter = new AzureOpenAIAdapter({
      endpoint: endpoint ?? "",
      apiVersion: apiVersion ?? "",
      deployments: { live: deployment ?? "" },
      auth: { kind: "api_key", apiKey: { reveal: () => apiKey ?? "" } },
    });
    const id = "00000000000000000000000000";
    const result = await adapter.complete(
      {
        requestId: id,
        model: { provider: "azure-live", model: "live" },
        messages: [{ role: "user", parts: [{ type: "text", text: "Say hello." }] }],
      },
      {
        signal: new AbortController().signal,
        ids: { next: () => id },
        clock: { now: () => Date.now() },
      },
    );

    expect(result.parts.some((part) => part.type === "text")).toBe(true);
  });
});
