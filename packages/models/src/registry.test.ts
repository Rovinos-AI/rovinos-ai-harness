// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { ProviderNotRegisteredError } from "./errors.js";
import { AdapterRegistry } from "./registry.js";
import type { ProviderAdapter } from "./types.js";

const adapter: ProviderAdapter = {
  provider: "sample",
  kind: "openai",
  complete: () =>
    Promise.resolve({
      parts: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      finishReason: "stop",
      latencyMs: 0,
    }),
};

describe("AdapterRegistry", () => {
  it("selects the adapter registered for a provider", () => {
    const registry = new AdapterRegistry([adapter]);

    expect(registry.get("sample")).toBe(adapter);
  });

  it("throws a typed error for unknown providers", () => {
    const registry = new AdapterRegistry([]);
    let thrown: unknown;

    try {
      registry.get("missing");
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProviderNotRegisteredError);
    expect(thrown).toHaveProperty("code", "provider_not_registered");
  });
});
