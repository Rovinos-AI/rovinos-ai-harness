// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { ControlPlaneConfigSchema } from "./control-plane.js";

describe("ControlPlaneConfigSchema", () => {
  it("defaults to disabled optional behavior, loopback binding, and a bounded request rate", () => {
    expect(ControlPlaneConfigSchema.parse({})).toEqual({
      allowReveal: false,
      allowAgentStartedRuns: false,
      auth: { tokens: [] },
      listen: { host: "127.0.0.1", port: 3_000 },
      allowedHosts: ["127.0.0.1", "localhost", "::1"],
      rateLimitPerMinute: 120,
    });
  });

  it("accepts auth, run filters, TLS references, and explicit start permissions", () => {
    expect(
      ControlPlaneConfigSchema.parse({
        allowReveal: true,
        allowAgentStartedRuns: true,
        auth: {
          tokens: [
            {
              id: "token.viewer",
              secret: "env:CONTROL_PLANE_TOKEN",
              scopes: ["read"],
              runIds: ["00000000000000000000000001"],
            },
          ],
        },
        listen: { host: "0.0.0.0", port: 4_321 },
        tls: { certFile: "file:/run/secrets/cert", keyFile: "file:/run/secrets/key" },
        allowedHosts: ["control.example.test"],
        rateLimitPerMinute: 60,
      }),
    ).toEqual({
      allowReveal: true,
      allowAgentStartedRuns: true,
      auth: {
        tokens: [
          {
            id: "token.viewer",
            secret: "env:CONTROL_PLANE_TOKEN",
            scopes: ["read"],
            runIds: ["00000000000000000000000001"],
          },
        ],
      },
      listen: { host: "0.0.0.0", port: 4_321 },
      tls: { certFile: "file:/run/secrets/cert", keyFile: "file:/run/secrets/key" },
      allowedHosts: ["control.example.test"],
      rateLimitPerMinute: 60,
    });
  });

  it("accepts the longest token id that fits its principal prefix", () => {
    const tokenId = "a".repeat(58);
    expect(
      ControlPlaneConfigSchema.safeParse({
        auth: { tokens: [{ id: tokenId, secret: "env:TOKEN", scopes: ["read"] }] },
      }).success,
    ).toBe(true);
    expect(
      ControlPlaneConfigSchema.safeParse({
        auth: { tokens: [{ id: `${tokenId}a`, secret: "env:TOKEN", scopes: ["read"] }] },
      }).success,
    ).toBe(false);
  });

  it.each([
    { auth: { tokens: [{ id: "bad id", secret: "env:TOKEN", scopes: ["read"] }] } },
    { auth: { tokens: [{ id: "valid.id", secret: "inline", scopes: ["read"] }] } },
    { auth: { tokens: [{ id: "valid.id", secret: "env:TOKEN", scopes: ["invalid"] }] } },
    {
      auth: {
        tokens: [
          { id: "token.same", secret: "env:FIRST", scopes: ["read"] },
          { id: "token.same", secret: "env:SECOND", scopes: ["read"] },
        ],
      },
    },
    {
      auth: {
        tokens: [{ id: "token.viewer", secret: "env:TOKEN", scopes: ["read"], runIds: [] }],
      },
    },
    { listen: { host: "", port: 3_000 } },
    { listen: { host: "127.0.0.1", port: 65_536 } },
    { tls: { certFile: "file:relative", keyFile: "file:/run/secrets/key" } },
    { allowedHosts: [] },
    { rateLimitPerMinute: 0 },
  ])("rejects invalid authentication and listener settings %#", (settings) => {
    expect(ControlPlaneConfigSchema.safeParse(settings).success).toBe(false);
  });

  it("rejects unknown keys at each configuration boundary", () => {
    expect(ControlPlaneConfigSchema.safeParse({ unexpected: true }).success).toBe(false);
    expect(
      ControlPlaneConfigSchema.safeParse({ auth: { tokens: [], unexpected: true } }).success,
    ).toBe(false);
    expect(
      ControlPlaneConfigSchema.safeParse({
        auth: {
          tokens: [{ id: "token.viewer", secret: "env:TOKEN", scopes: ["read"], extra: true }],
        },
      }).success,
    ).toBe(false);
  });
});
