// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { HostConfigSchema } from "./host.js";

describe("HostConfigSchema", () => {
  it("applies loopback and deny-by-default settings", () => {
    expect(HostConfigSchema.parse({})).toEqual({
      apps: [],
      listen: { host: "127.0.0.1", port: 0 },
      maxUiSessions: 32,
      permissionAllowlist: [],
      cspAllowlist: [],
      uiSessionMaxMs: 3_600_000,
    });
  });

  it("accepts unique ui resources and allowlists", () => {
    expect(
      HostConfigSchema.parse({
        apps: [
          {
            id: "approval",
            resourceUri: "ui://approval/index.html",
            telemetry: true,
            allowedTools: ["approve"],
          },
        ],
        listen: { host: "::1", port: 8080 },
        permissionAllowlist: ["camera"],
        cspAllowlist: ["https://images.example.test"],
      }).apps,
    ).toHaveLength(1);
  });

  it("defaults app telemetry to false", () => {
    expect(
      HostConfigSchema.parse({
        apps: [{ id: "approval", resourceUri: "ui://approval/index.html", allowedTools: [] }],
      }).apps[0]?.telemetry,
    ).toBe(false);
  });

  it("accepts UI-session lifetime and active-session limits", () => {
    expect(HostConfigSchema.parse({ maxUiSessions: 8, uiSessionMaxMs: 60_000 })).toMatchObject({
      maxUiSessions: 8,
      uiSessionMaxMs: 60_000,
    });
    expect(HostConfigSchema.safeParse({ maxUiSessions: 0 }).success).toBe(false);
    expect(HostConfigSchema.safeParse({ maxUiSessions: 1025 }).success).toBe(false);
    expect(HostConfigSchema.safeParse({ uiSessionMaxMs: 0 }).success).toBe(false);
  });

  it("rejects non-loopback addresses and unknown keys", () => {
    expect(HostConfigSchema.safeParse({ listen: { host: "0.0.0.0" } }).success).toBe(false);
    expect(
      HostConfigSchema.safeParse({ cspAllowlist: ["http://external.example.test"] }).success,
    ).toBe(false);
    expect(HostConfigSchema.safeParse({ cspAllowlist: ["https://safe.test/path"] }).success).toBe(
      false,
    );
    expect(HostConfigSchema.safeParse({ cspAllowlist: ["https://*.example.test"] }).success).toBe(
      false,
    );
    expect(HostConfigSchema.safeParse({ unexpected: true }).success).toBe(false);
  });

  it("rejects duplicate app IDs, resources, and tools", () => {
    const app = {
      id: "approval",
      resourceUri: "ui://approval/index.html",
      telemetry: false,
      allowedTools: ["approve", "approve"],
    };
    expect(HostConfigSchema.safeParse({ apps: [app, app] }).success).toBe(false);
  });
});
