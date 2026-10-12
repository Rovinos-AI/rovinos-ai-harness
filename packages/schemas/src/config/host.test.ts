// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { HostConfigSchema } from "./host.js";

describe("HostConfigSchema", () => {
  it("applies loopback and deny-by-default settings", () => {
    expect(HostConfigSchema.parse({})).toEqual({
      apps: [],
      listen: { host: "127.0.0.1", port: 0 },
      permissionAllowlist: [],
      cspAllowlist: [],
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

  it("rejects non-loopback addresses and unknown keys", () => {
    expect(HostConfigSchema.safeParse({ listen: { host: "0.0.0.0" } }).success).toBe(false);
    expect(
      HostConfigSchema.safeParse({ cspAllowlist: ["http://external.example.test"] }).success,
    ).toBe(false);
    expect(HostConfigSchema.safeParse({ cspAllowlist: ["https://safe.test/path"] }).success).toBe(
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
