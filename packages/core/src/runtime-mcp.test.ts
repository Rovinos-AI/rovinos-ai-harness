// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RunConfigSchema,
  SecretRefSchema,
  ServerConfigSchema,
  type SecretRef,
} from "@rovinos/schemas";
import { LocalKeyProvider } from "@rovinos/vault";
import { afterEach, expect, it, vi } from "vitest";
import { McpConnectionError, OAuthTokenStore } from "@rovinos/mcp";
import type { McpToolPort } from "@rovinos/mcp";
import type * as McpModule from "@rovinos/mcp";
import { createConfiguredMcpToolPort } from "./runtime-mcp.js";

type CreateMcpToolPort = typeof McpToolPort.create;

const mcpMocks = vi.hoisted(() => ({
  create: vi.fn<CreateMcpToolPort>(),
}));

vi.mock("@rovinos/mcp", async (importOriginal) => {
  const actual = await importOriginal<typeof McpModule>();
  return { ...actual, McpToolPort: { create: mcpMocks.create } };
});

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  mcpMocks.create.mockClear();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

it("opens the OAuth store and preserves discovery logging on tool-port failure", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "runtime-mcp-oauth-"));
  temporaryDirectories.push(dataDir);
  const keys = new LocalKeyProvider({
    secretResolver: { resolve: () => Promise.reject(new Error("unused test secret")) },
    env: { NODE_ENV: "test" },
    onWarning: vi.fn(),
  });
  const server = ServerConfigSchema.parse({
    id: "remote",
    transport: {
      kind: "http",
      url: "https://mcp.example.test/mcp",
      auth: {
        kind: "oauth",
        grant: "client_credentials",
        clientId: "runtime-test",
        clientSecret: "env:OAUTH_CLIENT_SECRET",
      },
    },
  });
  const closeTokenStore = vi.spyOn(OAuthTokenStore.prototype, "close");
  mcpMocks.create.mockImplementation((servers, dependencies) => {
    const firstServer = servers[0];
    if (firstServer === undefined) {
      return Promise.reject(new Error("expected configured MCP server"));
    }
    dependencies.logger?.log({ code: "mcp_discovery_failed", serverId: firstServer.id });
    dependencies.oauthTokenStore?.close();
    return Promise.reject(new McpConnectionError("mcp_list_tools_failed"));
  });

  try {
    await expect(
      createConfiguredMcpToolPort(
        { run: RunConfigSchema.parse({}), servers: [server] },
        {},
        keys,
        dataDir,
      ),
    ).rejects.toMatchObject({ code: "mcp_list_tools_failed" });
    expect((await stat(join(dataDir, "mcp-oauth.db"))).mode & 0o777).toBe(0o600);
    expect(mcpMocks.create).toHaveBeenCalledOnce();
    expect(closeTokenStore).toHaveBeenCalledOnce();
  } finally {
    keys.dispose();
  }
});

it("fails closed when a configured server needs an unresolved secret", async () => {
  const keys = new LocalKeyProvider({
    secretResolver: { resolve: () => Promise.reject(new Error("unused test secret")) },
    env: { NODE_ENV: "test" },
    onWarning: vi.fn(),
  });
  const server = ServerConfigSchema.parse({
    id: "remote",
    transport: {
      kind: "http",
      url: "https://mcp.example.test/mcp",
    },
  });
  mcpMocks.create.mockImplementation(async (_servers, dependencies) => {
    await expect(
      dependencies.resolveSecret(SecretRefSchema.parse("env:UNCONFIGURED_SECRET")),
    ).rejects.toMatchObject({ code: "mcp_connect_failed" });
    throw new McpConnectionError("mcp_list_tools_failed");
  });

  try {
    await expect(
      createConfiguredMcpToolPort(
        { run: RunConfigSchema.parse({}), servers: [server] },
        {},
        keys,
        "",
      ),
    ).rejects.toMatchObject({ code: "mcp_list_tools_failed" });
    expect(mcpMocks.create).toHaveBeenCalledOnce();
  } finally {
    keys.dispose();
  }
});

it("maps missing and configured MCP secrets through the resolver boundary", async () => {
  mcpMocks.create.mockClear();
  const keys = new LocalKeyProvider({
    secretResolver: { resolve: () => Promise.reject(new Error("unused test secret")) },
    env: { NODE_ENV: "test" },
    onWarning: vi.fn(),
  });
  const server = ServerConfigSchema.parse({
    id: "remote",
    transport: { kind: "stdio", command: "node" },
  });
  const config = { run: RunConfigSchema.parse({}), servers: [server] };
  const captured: {
    resolveSecret?: (reference: SecretRef) => Promise<string>;
  } = {};
  const getResolveSecret = (): ((reference: SecretRef) => Promise<string>) => {
    const resolveSecret = captured.resolveSecret;
    if (resolveSecret === undefined) {
      throw new Error("The configured MCP secret resolver was not captured.");
    }
    return resolveSecret;
  };
  mcpMocks.create.mockImplementation((_servers, dependencies) => {
    captured.resolveSecret = dependencies.resolveSecret;
    return Promise.reject(new McpConnectionError("mcp_connect_failed"));
  });

  try {
    await expect(
      createConfiguredMcpToolPort(config, {}, keys, ".tmp/runtime-mcp-test"),
    ).rejects.toMatchObject({ code: "mcp_connect_failed" });
    await expect(
      getResolveSecret()(SecretRefSchema.parse("env:TEST_SECRET")),
    ).rejects.toMatchObject({ code: "mcp_connect_failed" });

    await expect(
      createConfiguredMcpToolPort(
        config,
        {
          secretResolver: { resolve: () => Promise.resolve({ reveal: () => "synthetic-secret" }) },
        },
        keys,
        ".tmp/runtime-mcp-test",
      ),
    ).rejects.toMatchObject({ code: "mcp_connect_failed" });
    await expect(getResolveSecret()(SecretRefSchema.parse("env:TEST_SECRET"))).resolves.toBe(
      "synthetic-secret",
    );
    expect(mcpMocks.create).toHaveBeenCalledTimes(2);
  } finally {
    keys.dispose();
  }
});
