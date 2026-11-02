// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { ProviderError } from "../errors.js";
import { createProviderToolAliases } from "./tool-aliases.js";

describe("provider tool aliases", () => {
  it("keeps aliases readable and bounds long names with deterministic suffixes", () => {
    const toolIds = [
      "weather.forecast",
      "server.tool!@#$%",
      "server.東京",
      `server.${"long".repeat(100)}`,
    ];
    const aliases = createProviderToolAliases(toolIds);
    const names = toolIds.map((toolId) => aliases.toProviderName(toolId));

    expect(names).toEqual(
      toolIds.map((toolId) => createProviderToolAliases([toolId]).toProviderName(toolId)),
    );
    expect(new Set(names).size).toBe(toolIds.length);
    expect(names.every((name) => /^[\w-]{1,64}$/u.test(name))).toBe(true);
    expect(names[0]).toBe("weather_forecast");
    expect(names[1]).toBe("server_tool_");
    expect(names[3]).toHaveLength(64);
    expect(names[3]).toMatch(/^server_(?:long)+_[0-9a-f]{8}$/u);
  });

  it("adds digest suffixes when distinct canonical IDs sanitize to the same name", () => {
    const aliases = createProviderToolAliases(["a.b", "a_b"]);
    const dotted = aliases.toProviderName("a.b");
    const underscored = aliases.toProviderName("a_b");

    expect(dotted).toMatch(/^a_b_[0-9a-f]{8}$/u);
    expect(underscored).toMatch(/^a_b_[0-9a-f]{8}$/u);
    expect(dotted).not.toBe(underscored);
    expect(aliases.toCanonicalName(dotted)).toBe("a.b");
    expect(aliases.toCanonicalName(underscored)).toBe("a_b");
  });

  it("disambiguates long names with shared prefixes", () => {
    const firstId = `server.${"x".repeat(80)}first`;
    const secondId = `server.${"x".repeat(80)}second`;
    const aliases = createProviderToolAliases([firstId, secondId]);
    const first = aliases.toProviderName(firstId);
    const second = aliases.toProviderName(secondId);

    expect(first).toHaveLength(64);
    expect(second).toHaveLength(64);
    expect(first).not.toBe(second);
    expect(first.slice(0, 55)).toBe(second.slice(0, 55));
    expect(aliases.toCanonicalName(first)).toBe(firstId);
    expect(aliases.toCanonicalName(second)).toBe(secondId);
  });

  it("re-hashes names when a digest suffix collides with a native name", () => {
    const longId = "x".repeat(65);
    const generatedAlias = createProviderToolAliases([longId]).toProviderName(longId);
    const aliases = createProviderToolAliases([longId, generatedAlias]);
    const longAlias = aliases.toProviderName(longId);
    const nativeAlias = aliases.toProviderName(generatedAlias);

    expect(longAlias).toBe(generatedAlias);
    expect(nativeAlias).not.toBe(generatedAlias);
    expect(longAlias).not.toBe(nativeAlias);
    expect(aliases.toCanonicalName(longAlias)).toBe(longId);
    expect(aliases.toCanonicalName(nativeAlias)).toBe(generatedAlias);
  });

  it("translates history aliases and permits history-only IDs only in the outbound direction", () => {
    const aliases = createProviderToolAliases(["weather.forecast"], ["old.weather"]);
    const historicalAlias = aliases.toProviderName("old.weather");

    expect(aliases.providerNameForHistory("weather.forecast")).toBe(
      aliases.toProviderName("weather.forecast"),
    );
    expect(aliases.providerNameForHistory(historicalAlias)).toBe(historicalAlias);
    expect(aliases.toAdvertisedProviderName("weather.forecast")).toBe(
      aliases.toProviderName("weather.forecast"),
    );
    expect(() => aliases.toAdvertisedProviderName("old.weather")).toThrow(ProviderError);
    expect(() => aliases.toCanonicalName(historicalAlias)).toThrow(ProviderError);
  });

  it("rejects unknown aliases, unregistered history, and duplicate advertised IDs", () => {
    const aliases = createProviderToolAliases(["weather.forecast"]);

    expect(() => aliases.toProviderName("unknown.tool")).toThrow(ProviderError);
    expect(() => aliases.toCanonicalName("unknown_alias")).toThrow(ProviderError);
    expect(() => aliases.providerNameForHistory("unknown.tool")).toThrow(ProviderError);
    expect(() => createProviderToolAliases(["duplicate", "duplicate"])).toThrow(ProviderError);
  });
});
