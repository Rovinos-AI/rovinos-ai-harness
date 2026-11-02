// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { ProviderError } from "../errors.js";
import { createProviderToolAliases } from "./tool-aliases.js";

describe("provider tool aliases", () => {
  it("creates deterministic, bounded aliases for punctuation, Unicode, and long IDs", () => {
    const toolIds = [
      "weather.forecast",
      "server.tool!@#$%",
      "server.東京",
      "server.e\u0301",
      "server.\u00e9",
      `server.${"long".repeat(100)}`,
    ];
    const aliases = createProviderToolAliases(toolIds);
    const names = toolIds.map((toolId) => aliases.toProviderName(toolId));

    expect(names).toEqual(
      toolIds.map((toolId) => createProviderToolAliases([toolId]).toProviderName(toolId)),
    );
    expect(new Set(names).size).toBe(toolIds.length);
    expect(names.every((name) => /^[A-Za-z0-9_-]{1,64}$/u.test(name))).toBe(true);
    expect(names.every((name) => name.length === 64)).toBe(true);
    expect(names[3]).not.toBe(names[4]);
  });

  it("keeps duplicate native names from separate servers distinct by canonical ID", () => {
    const aliases = createProviderToolAliases(["server_a.weather", "server_b.weather"]);
    const first = aliases.toProviderName("server_a.weather");
    const second = aliases.toProviderName("server_b.weather");

    expect(first).not.toBe(second);
    expect(aliases.toCanonicalName(first)).toBe("server_a.weather");
    expect(aliases.toCanonicalName(second)).toBe("server_b.weather");
  });

  it("translates history aliases and permits history-only IDs only in the outbound direction", () => {
    const aliases = createProviderToolAliases(["weather.forecast"], ["old.weather"]);
    const historicalAlias = aliases.toProviderName("old.weather");

    expect(aliases.providerNameForHistory("weather.forecast")).toBe(
      aliases.toProviderName("weather.forecast"),
    );
    expect(aliases.providerNameForHistory(historicalAlias)).toBe(historicalAlias);
    expect(() => aliases.toCanonicalName(historicalAlias)).toThrow(ProviderError);
  });

  it("rejects unknown aliases, unregistered history, and duplicate advertised IDs", () => {
    const aliases = createProviderToolAliases(["weather.forecast"]);

    expect(() => aliases.toCanonicalName("unknown_alias")).toThrow(ProviderError);
    expect(() => aliases.providerNameForHistory("unknown.tool")).toThrow(ProviderError);
    expect(() => createProviderToolAliases(["duplicate", "duplicate"])).toThrow(ProviderError);
  });
});
