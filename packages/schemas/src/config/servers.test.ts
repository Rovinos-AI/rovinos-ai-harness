// SPDX-License-Identifier: Apache-2.0
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseYaml } from "../parse.js";
import { ServerConfigSchema, ServersConfigSchema } from "./servers.js";

const configWithTransport = (transport: unknown) => ({
  id: "server",
  transport,
});

describe("ServerConfigSchema", () => {
  it("applies defaults and uses the server id as the default tool prefix", () => {
    expect(
      ServerConfigSchema.parse({
        id: "internal",
        transport: { kind: "stdio", command: "node" },
        trust: "internal",
      }),
    ).toEqual({
      id: "internal",
      transport: { kind: "stdio", command: "node", args: [], inheritEnv: false },
      protocol: "auto",
      apps: false,
      trust: "internal",
      propagateTrace: false,
      toolPrefix: "internal",
      useAnnotations: false,
      timeouts: { connectMs: 10_000, callMs: 60_000 },
      maxResultBytes: 1_048_576,
    });
  });

  it("accepts configured options and native tool names", () => {
    const parsed = ServerConfigSchema.parse({
      id: "mcp.weather",
      transport: {
        kind: "stdio",
        command: "node",
        args: ["server.js"],
        env: { HOME: "/tmp", API_KEY: "env:WEATHER_API_KEY" },
        cwd: "/srv/weather",
        inheritEnv: true,
      },
      protocol: "2025-11-25",
      apps: true,
      trust: "internal",
      propagateTrace: true,
      toolAllowlist: ["forecast-current"],
      toolPrefix: "weather",
      idempotentTools: ["forecast-current"],
      useAnnotations: true,
      timeouts: { connectMs: 500, callMs: 2_000 },
      maxResultBytes: 100_000,
    });

    expect(parsed).toMatchObject({
      transport: { args: ["server.js"], env: { API_KEY: "env:WEATHER_API_KEY" } },
      protocol: "2025-11-25",
      apps: true,
      propagateTrace: true,
      toolAllowlist: ["forecast-current"],
      toolPrefix: "weather",
      idempotentTools: ["forecast-current"],
      useAnnotations: true,
      timeouts: { connectMs: 500, callMs: 2_000 },
      maxResultBytes: 100_000,
    });
  });

  it("rejects trace propagation for external servers with its stable error code", () => {
    const result = ServerConfigSchema.safeParse({
      id: "external",
      transport: { kind: "stdio", command: "node" },
      propagateTrace: true,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some(
          (issue) =>
            issue.code === "custom" && issue.params?.errorCode === "propagate_requires_internal",
        ),
      ).toBe(true);
    }
  });

  it("rejects annotations for external servers", () => {
    expect(
      ServerConfigSchema.safeParse({
        id: "external",
        transport: { kind: "stdio", command: "node" },
        useAnnotations: true,
      }).success,
    ).toBe(false);
  });

  it.each(["API_KEY", "accessToken", "client_secret", "password", "credential"])(
    "requires SecretRef for secret-looking stdio environment key %s",
    (key) => {
      expect(
        ServerConfigSchema.safeParse({
          id: "stdio",
          transport: { kind: "stdio", command: "node", env: { [key]: "inline-secret" } },
        }).success,
      ).toBe(false);
      expect(
        ServerConfigSchema.safeParse({
          id: "stdio",
          transport: {
            kind: "stdio",
            command: "node",
            env: { [key]: "env:CONFIGURED_SECRET" },
          },
        }).success,
      ).toBe(true);
    },
  );

  it("requires SecretRef values for HTTP headers", () => {
    expect(
      ServerConfigSchema.safeParse({
        id: "http",
        transport: {
          kind: "http",
          url: "https://mcp.example",
          headers: { Authorization: "******" },
        },
      }).success,
    ).toBe(false);
    expect(
      ServerConfigSchema.safeParse({
        id: "http",
        transport: {
          kind: "http",
          url: "https://mcp.example",
          headers: { Authorization: "env:MCP_AUTHORIZATION" },
        },
      }).success,
    ).toBe(true);
  });

  it.each([
    ["https://mcp.example", true],
    ["http://localhost:8080", true],
    ["http://127.0.0.1:8080", true],
    ["http://[::1]:8080", true],
    ["http://mcp.example", false],
    ["ftp://localhost", false],
    ["not a URL", false],
  ])("validates HTTP server URL %s", (url, valid) => {
    expect(
      ServerConfigSchema.safeParse(
        configWithTransport({ kind: "http", url, headers: { Authorization: "env:MCP_AUTH" } }),
      ).success,
    ).toBe(valid);
  });

  it("requires a Code for the configured tool prefix and positive integer limits", () => {
    const config = {
      id: "server",
      transport: { kind: "stdio", command: "node" },
    };
    expect(ServerConfigSchema.safeParse({ ...config, toolPrefix: "Not Valid" }).success).toBe(
      false,
    );
    expect(ServerConfigSchema.safeParse({ ...config, maxResultBytes: 0 }).success).toBe(false);
    expect(
      ServerConfigSchema.safeParse({
        ...config,
        timeouts: { connectMs: 1.5 },
      }).success,
    ).toBe(false);
  });
});

describe("ServersConfigSchema", () => {
  it("defaults to an empty server list", () => {
    expect(ServersConfigSchema.parse(undefined)).toEqual([]);
  });

  it("rejects duplicate server IDs", () => {
    const server = { id: "duplicate", transport: { kind: "stdio", command: "node" } };
    expect(ServersConfigSchema.safeParse([server, server]).success).toBe(false);
  });

  it("validates the sample servers YAML", async () => {
    const yaml = await readFile(
      new URL("../../../../examples/servers.yaml", import.meta.url),
      "utf8",
    );
    const configSchema = z.object({ servers: ServersConfigSchema }).strict();

    expect(parseYaml(configSchema, yaml).servers).toHaveLength(2);
  });
});
