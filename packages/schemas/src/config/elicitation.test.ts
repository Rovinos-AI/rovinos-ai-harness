// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { ElicitationConfigSchema, ServerElicitationConfigSchema } from "./elicitation.js";

describe("ElicitationConfigSchema", () => {
  it("defaults to no channels, HTTPS, and a seven-day expiry", () => {
    expect(ElicitationConfigSchema.parse({})).toEqual({
      channels: [],
      requireHttps: true,
      expiresAfterMs: 604_800_000,
    });
  });

  it("accepts configured channels and host allowlists", () => {
    expect(
      ElicitationConfigSchema.parse({
        channels: ["control_plane", "cli", "app"],
        urlAllowHosts: ["example.test"],
        expiresAfterMs: 1_000,
      }),
    ).toMatchObject({
      channels: ["control_plane", "cli", "app"],
      urlAllowHosts: ["example.test"],
      expiresAfterMs: 1_000,
    });
  });

  it("rejects unknown keys, channels, and invalid limits", () => {
    expect(ElicitationConfigSchema.safeParse({ unexpected: true }).success).toBe(false);
    expect(ElicitationConfigSchema.safeParse({ channels: ["web"] }).success).toBe(false);
    expect(ElicitationConfigSchema.safeParse({ expiresAfterMs: 0 }).success).toBe(false);
    expect(ElicitationConfigSchema.parse({ requireHttps: false }).requireHttps).toBe(false);
  });
});

describe("ServerElicitationConfigSchema", () => {
  it("defaults to disabled with form mode and bounded limits", () => {
    expect(ServerElicitationConfigSchema.parse({})).toEqual({
      enabled: false,
      modes: ["form"],
      maxRounds: 5,
      maxPerRun: 20,
      maxRequestStateBytes: 65_536,
      legacyLiveTimeoutMs: 300_000,
    });
  });

  it("accepts configured modes and overrides", () => {
    expect(
      ServerElicitationConfigSchema.parse({
        enabled: true,
        modes: ["form", "url"],
        maxRounds: 2,
        maxPerRun: 4,
        maxRequestStateBytes: 1_024,
        legacyLiveTimeoutMs: 500,
      }),
    ).toEqual({
      enabled: true,
      modes: ["form", "url"],
      maxRounds: 2,
      maxPerRun: 4,
      maxRequestStateBytes: 1_024,
      legacyLiveTimeoutMs: 500,
    });
  });

  it("rejects unknown keys, modes, and zero limits", () => {
    expect(ServerElicitationConfigSchema.safeParse({ unknown: true }).success).toBe(false);
    expect(ServerElicitationConfigSchema.safeParse({ modes: ["email"] }).success).toBe(false);
    expect(ServerElicitationConfigSchema.safeParse({ maxRounds: 0 }).success).toBe(false);
    expect(ServerElicitationConfigSchema.safeParse({ maxPerRun: 0 }).success).toBe(false);
    expect(ServerElicitationConfigSchema.safeParse({ maxRequestStateBytes: 0 }).success).toBe(
      false,
    );
    expect(ServerElicitationConfigSchema.safeParse({ legacyLiveTimeoutMs: 0 }).success).toBe(false);
  });
});
