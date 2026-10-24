// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunConfigSchema, ServerConfigSchema } from "@rovinos/schemas";
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
