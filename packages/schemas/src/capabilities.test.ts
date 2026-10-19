// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { lookupCapabilities } from "./capabilities.js";

describe("lookupCapabilities", () => {
  it("uses provider defaults for an unknown model", () => {
    expect(lookupCapabilities({ provider: "anthropic", model: "unknown" })).toEqual({
      capabilities: {
        structuredOutput: "tool",
        forcedToolChoice: true,
        parallelToolCalls: false,
        maxContextTokens: 0,
        opaqueRoundTrip: true,
      },
      source: "default",
    });
  });

  it("defaults Vertex to native structured output while honoring configured overrides", () => {
    expect(lookupCapabilities({ provider: "vertex", model: "unknown" }).capabilities).toMatchObject(
      {
        structuredOutput: "native",
      },
    );
    expect(
      lookupCapabilities({ provider: "vertex", model: "unknown" }, { structuredOutput: "none" })
        .capabilities,
    ).toMatchObject({ structuredOutput: "none" });
  });

  it("defaults Bedrock to forced-tool structured output and opaque round trips", () => {
    expect(lookupCapabilities({ provider: "bedrock", model: "nova-pro" })).toEqual({
      capabilities: {
        structuredOutput: "tool",
        forcedToolChoice: true,
        parallelToolCalls: false,
        maxContextTokens: 0,
        opaqueRoundTrip: true,
      },
      source: "default",
    });
  });

  it("overrides only configured capabilities", () => {
    expect(
      lookupCapabilities(
        { provider: "openai", model: "unknown" },
        { structuredOutput: "json_mode", maxContextTokens: 100 },
      ),
    ).toEqual({
      capabilities: {
        structuredOutput: "json_mode",
        forcedToolChoice: true,
        parallelToolCalls: true,
        maxContextTokens: 100,
        opaqueRoundTrip: true,
      },
      source: "config",
    });
  });

  it("falls back to conservative defaults for unknown providers", () => {
    expect(lookupCapabilities({ provider: "unknown", model: "unknown" }).capabilities).toEqual({
      structuredOutput: "none",
      forcedToolChoice: false,
      parallelToolCalls: false,
      maxContextTokens: 0,
      opaqueRoundTrip: false,
    });
  });

  it("rejects invalid refs", () => {
    expect(() => lookupCapabilities({ provider: "bad code", model: "unknown" })).toThrow();
  });
});
