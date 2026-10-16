// SPDX-License-Identifier: Apache-2.0
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryTransport, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { HarnessConfigSchema } from "@harness/config";
import { OAuthTokenStore } from "@harness/mcp";
import { parseJson, ServersCheckResultSchema, type KeyProvider } from "@harness/schemas";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { CliContext } from "../command.js";
import { ExitCode } from "../exit-codes.js";
import { createOutput } from "../output.js";
import { main } from "../main.js";
import { createServersCommand } from "./servers.js";

const descriptionCanary = "servers-check-description-canary";
const errorCanary = "servers-check-error-canary";
const inputSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

let serverTransports: InMemoryTransport[] = [];
let httpServers: Server[] = [];
let toolCalls = 0;
const oauthAccessToken = "servers-login-access-token-canary";
const oauthKey = Buffer.alloc(32, 41);
const keyProvider: KeyProvider = {
  currentKeyId: () => "test-key",
  getKey: () => Promise.resolve(new Uint8Array(oauthKey)),
};

function createContext(
  loadConfigForTest: CliContext["loadConfig"],
  options: {
    readonly secretResolver?: CliContext["secretResolver"];
    readonly now?: () => number;
  } = {},
) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const context: CliContext = {
    loadConfig: loadConfigForTest,
    out: createOutput({
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    }),
    ...(options.secretResolver === undefined ? {} : { secretResolver: options.secretResolver }),
    clock: { now: options.now ?? (() => 20) },
  };
  return { context, stdout, stderr };
}

async function createPeer(
  tools?: { name: string; description?: string }[],
  beforeList?: () => void | Promise<void>,
) {
  const [client, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = new McpServer({ name: errorCanary, version: "1.0.0" });
  server.server.registerCapabilities({
    tools: {},
    extensions: { "io.modelcontextprotocol/ui": {} },
  });
  server.server.setRequestHandler("tools/list", async () => {
    await beforeList?.();
    return {
      tools: tools?.map((tool) => ({
        ...tool,
        inputSchema,
      })) ?? [
        { name: "available", description: descriptionCanary, inputSchema },
        { name: "filtered", description: errorCanary, inputSchema },
      ],
    };
  });
  server.server.setRequestHandler("tools/call", () => {
    toolCalls += 1;
    return { content: [{ type: "text", text: errorCanary }] };
  });
  await server.connect(serverTransport);
  serverTransports.push(serverTransport);
  return client;
}

function createModernHttpPeer(toolName: string) {
  const serverFactory = () => {
    const server = new McpServer(
      { name: errorCanary, version: "1.0.0" },
      { supportedProtocolVersions: ["2026-07-28"] },
    );
    server.server.registerCapabilities({
      tools: {},
      extensions: { "io.modelcontextprotocol/ui": {} },
    });
    server.server.setRequestHandler("tools/list", () => ({
      tools: [
        {
          name: toolName,
          inputSchema: {
            type: "object",
            properties: { token: { type: "string", "x-mcp-header": "traceparent" } },
          },
        },
      ],
    }));
    return server;
  };
  const handler = createMcpHandler(serverFactory, { legacy: "reject" });
  return new StreamableHTTPClientTransport(new URL("https://localhost/mcp"), {
    fetch: async (input, init) => handler.fetch(new Request(input, init)),
  });
}

function config(servers?: unknown) {
  return HarnessConfigSchema.parse({ ...(servers === undefined ? {} : { servers }) });
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

async function createOAuthServer() {
  let issuer = "";
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (request.method === "GET" && url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
        sendJson(response, {
          resource: `http://${request.headers.host}/mcp`,
          authorization_servers: [issuer],
          scopes_supported: ["tools:read"],
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {
        sendJson(response, {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          registration_endpoint: `${issuer}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          authorization_response_iss_parameter_supported: true,
          token_endpoint_auth_methods_supported: ["none"],
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/register") {
        const registration = parseJson(
          z.object({ redirect_uris: z.array(z.url()) }).passthrough(),
          await readRequestBody(request),
        );
        sendJson(response, { ...registration, client_id: "cli-registered-client" });
        return;
      }
      if (request.method === "POST" && url.pathname === "/token") {
        sendJson(response, {
          access_token: oauthAccessToken,
          refresh_token: "servers-login-refresh-token",
          token_type: "Bearer",
          expires_in: 3600,
        });
        return;
      }
      response.writeHead(404).end();
    })().catch(() => response.writeHead(500).end());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  httpServers.push(server);
  const address = server.address() as AddressInfo;
  issuer = `http://127.0.0.1:${String(address.port)}`;
  return issuer;
}

afterEach(async () => {
  toolCalls = 0;
  await Promise.all(serverTransports.map((transport) => transport.close()));
  serverTransports = [];
  await Promise.all(
    httpServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          if (!server.listening) {
            resolve();
          } else {
            server.close(() => resolve());
          }
        }),
    ),
  );
  vi.unstubAllEnvs();
});

describe("harness servers check", () => {
  it("reports safe registry and propagation diagnostics without invoking tools", async () => {
    const peer = await createPeer();
    const serverConfig = {
      id: "primary",
      transport: { kind: "stdio", command: "not-spawned-by-memory-transport" },
      trust: "internal",
      toolAllowlist: ["available"],
    };
    const { context, stdout, stderr } = createContext(() =>
      Promise.resolve(config([serverConfig])),
    );

    const exitCode = await main(["--json", "servers", "check"], context, [
      createServersCommand({ createTransport: () => Promise.resolve(peer) }),
    ]);
    const documents = stdout.join("").trim().split("\n");
    const result = parseJson(ServersCheckResultSchema, documents[0] ?? "");

    expect(exitCode).toBe(ExitCode.ok);
    expect(documents).toHaveLength(1);
    expect(result.servers).toEqual([
      expect.objectContaining({
        id: "primary",
        transportKind: "stdio",
        protocolEra: "legacy",
        protocolVersion: "2025-11-25",
        supportsApps: true,
        trust: "internal",
        reachable: true,
        toolCount: 2,
        registeredToolIds: ["primary.available"],
        rejectedTools: [{ reason: "tool_not_allowlisted" }],
        tracePropagation: "no",
        tracePropagationReason: "disabled",
        warnings: ["trace_propagation_disabled"],
      }),
    ]);
    expect(stderr).toEqual([]);
    expect(stdout.join("") + stderr.join("")).not.toContain(descriptionCanary);
    expect(stdout.join("") + stderr.join("")).not.toContain(errorCanary);
    expect(toolCalls).toBe(0);
  });

  it("returns a safe failure document when a server cannot be reached", async () => {
    const { context, stdout, stderr } = createContext(() =>
      Promise.resolve(
        config([
          {
            id: "offline",
            transport: { kind: "stdio", command: "unused" },
          },
        ]),
      ),
    );

    const exitCode = await main(["--json", "servers", "check"], context, [
      createServersCommand({
        createTransport: () => Promise.reject(new Error(errorCanary)),
      }),
    ]);
    const result = parseJson(ServersCheckResultSchema, stdout[0] ?? "");

    expect(exitCode).toBe(ExitCode.failure);
    expect(result.servers).toContainEqual(
      expect.objectContaining({
        id: "offline",
        reachable: false,
        errorCode: "mcp_connect_failed",
      }),
    );
    expect(stderr).toEqual(["servers_check_failed\n"]);
    expect(stdout.join("") + stderr.join("")).not.toContain(errorCanary);
  });

  it("passes connect cancellation to secret resolution and continues with the next server", async () => {
    const secretRefs: string[] = [];
    const { context, stdout } = createContext(
      () =>
        Promise.resolve(
          config(
            ["stalled", "next"].map((id) => ({
              id,
              transport: {
                kind: "http",
                url: "http://127.0.0.1:1/mcp",
                headers: { Authorization: `env:${id === "stalled" ? "STALL" : "NEXT"}` },
              },
              timeouts: { connectMs: 20, callMs: 100 },
            })),
          ),
        ),
      {
        secretResolver: {
          resolve(ref, signal) {
            secretRefs.push(ref);
            if (ref === "env:STALL") {
              return new Promise((_resolve, reject) => {
                if (signal?.aborted === true) {
                  reject(new Error("cancelled"));
                  return;
                }
                signal?.addEventListener(
                  "abort",
                  () => {
                    reject(new Error("cancelled"));
                  },
                  { once: true },
                );
              });
            }
            return Promise.resolve({ reveal: () => "synthetic-secret" });
          },
        },
      },
    );

    const exitCode = await main(["--json", "servers", "check"], context, [createServersCommand()]);
    const result = parseJson(ServersCheckResultSchema, stdout[0] ?? "");

    expect(exitCode).toBe(ExitCode.failure);
    expect(secretRefs).toEqual(["env:STALL", "env:NEXT"]);
    expect(result.servers).toEqual([
      expect.objectContaining({
        id: "stalled",
        reachable: false,
        errorCode: "mcp_connect_timeout",
      }),
      expect.objectContaining({ id: "next", reachable: false, errorCode: "mcp_connect_failed" }),
    ]);
  });

  it("reports tools excluded for invalid MCP header declarations", async () => {
    const peer = createModernHttpPeer("native-secret-tool");
    const { context, stdout } = createContext(() =>
      Promise.resolve(
        config([
          {
            id: "modern",
            transport: { kind: "http", url: "http://127.0.0.1:1/mcp" },
            protocol: "2026-07-28",
          },
        ]),
      ),
    );

    const exitCode = await main(["--json", "servers", "check"], context, [
      createServersCommand({ createTransport: () => peer }),
    ]);
    const result = parseJson(ServersCheckResultSchema, stdout[0] ?? "");

    expect(exitCode).toBe(ExitCode.ok);
    expect(result.servers).toEqual([
      expect.objectContaining({
        toolCount: 1,
        registeredToolIds: [],
        rejectedTools: [{ reason: "tool_header_invalid" }],
      }),
    ]);
    expect(stdout.join("")).not.toContain("native-secret-tool");
  });

  it("preserves connect latency when tools/list times out", async () => {
    let nowCalls = 0;
    let currentTime = 100;
    const peer = await createPeer(undefined, async () => {
      currentTime = 5_000;
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    const { context, stdout } = createContext(
      () =>
        Promise.resolve(
          config([
            {
              id: "slow-list",
              transport: { kind: "stdio", command: "not-spawned-by-memory-transport" },
              timeouts: { connectMs: 1_000, callMs: 5 },
            },
          ]),
        ),
      {
        now: () => {
          if (nowCalls++ === 0) {
            return 100;
          }
          if (nowCalls === 2) {
            return 110;
          }
          return currentTime;
        },
      },
    );

    const exitCode = await main(["--json", "servers", "check"], context, [
      createServersCommand({ createTransport: () => Promise.resolve(peer) }),
    ]);
    const result = parseJson(ServersCheckResultSchema, stdout[0] ?? "");

    expect(exitCode).toBe(ExitCode.failure);
    expect(result.servers).toEqual([
      expect.objectContaining({
        connectLatencyMs: 10,
        reachable: false,
        errorCode: "mcp_list_tools_failed",
      }),
    ]);
  });

  it("checks only the requested server", async () => {
    const peer = await createPeer();
    const serverConfigs = [
      { id: "first", transport: { kind: "stdio", command: "unused" } },
      { id: "second", transport: { kind: "stdio", command: "unused" } },
    ];
    const connected: string[] = [];
    const { context, stdout } = createContext(() => Promise.resolve(config(serverConfigs)));

    const exitCode = await main(["--json", "servers", "check", "--server", "second"], context, [
      createServersCommand({
        createTransport: (server) => {
          connected.push(server.id);
          return Promise.resolve(peer);
        },
      }),
    ]);
    const result = parseJson(ServersCheckResultSchema, stdout[0] ?? "");

    expect(exitCode).toBe(ExitCode.ok);
    expect(connected).toEqual(["second"]);
    expect(result.servers).toEqual([
      expect.objectContaining({
        id: "second",
        tracePropagation: "no",
        tracePropagationReason: "external",
      }),
    ]);
  });

  it("prints an explicit warning row for disabled trusted trace propagation", async () => {
    const peer = await createPeer();
    const serverConfig = {
      id: "primary",
      transport: { kind: "stdio", command: "unused" },
      trust: "internal",
    };
    const { context, stdout } = createContext(() => Promise.resolve(config([serverConfig])));

    const exitCode = await main(["servers", "check"], context, [
      createServersCommand({ createTransport: () => Promise.resolve(peer) }),
    ]);

    expect(exitCode).toBe(ExitCode.ok);
    expect(stdout.join("")).toContain("warning\tprimary\ttrace_propagation_disabled\n");
  });

  it("returns a safe JSON failure when the selected server is not configured", async () => {
    const { context, stdout, stderr } = createContext(() => Promise.resolve(config([])));

    const exitCode = await main(["--json", "servers", "check", "--server", "missing"], context, [
      createServersCommand(),
    ]);
    const result = parseJson(ServersCheckResultSchema, stdout[0] ?? "");

    expect(exitCode).toBe(ExitCode.failure);
    expect(result).toEqual({ servers: [], errorCode: "mcp_server_not_found" });
    expect(stderr).toEqual(["servers_check_failed\n"]);
  });

  it("logs in through a fake browser callback and removes the stored tokens on logout", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "mcp-oauth-cli-"));
    vi.stubEnv("HARNESS_DATA_DIR", dataDirectory);
    const serverUrl = await createOAuthServer();
    const configWithAuth = HarnessConfigSchema.parse({
      keys: {
        currentKeyId: "primary",
        keys: [{ id: "primary", secret: "env:OAUTH_KEY" }],
      },
      servers: [
        {
          id: "remote",
          transport: {
            kind: "http",
            url: `${serverUrl}/mcp`,
            auth: { kind: "oauth", grant: "authorization_code" },
          },
        },
      ],
    });
    const { context, stdout, stderr } = createContext(
      () => Promise.resolve(configWithAuth),
      {
        secretResolver: {
          resolve(ref) {
            if (ref === "env:OAUTH_KEY") {
              return Promise.resolve({ reveal: () => oauthKey.toString("base64") });
            }
            return Promise.reject(new Error("unexpected secret reference"));
          },
        },
      },
    );
    const openBrowser = vi.fn(async (url: string) => {
      const authorizationUrl = new URL(url);
      const callback = new URL(authorizationUrl.searchParams.get("redirect_uri") ?? "");
      callback.searchParams.set("code", "cli-authorization-code");
      callback.searchParams.set("state", authorizationUrl.searchParams.get("state") ?? "");
      callback.searchParams.set("iss", serverUrl);
      expect((await fetch(callback)).status).toBe(200);
    });
    try {
      const loginExit = await main(["servers", "login", "remote", "--open"], context, [
        createServersCommand({ openBrowser }),
      ]);
      expect(loginExit).toBe(ExitCode.ok);
      expect(openBrowser).toHaveBeenCalledOnce();
      expect(stdout[0]).toMatch(/^http:\/\/127\.0\.0\.1:/);
      expect(stderr).toEqual([]);
      expect(stdout.join("") + stderr.join("")).not.toContain(oauthAccessToken);
      const databasePath = join(dataDirectory, "mcp-oauth.db");
      const databaseBytes = await readFile(databasePath);
      expect(databaseBytes.includes(Buffer.from(oauthAccessToken))).toBe(false);

      const logoutExit = await main(["servers", "logout", "remote"], context, [
        createServersCommand(),
      ]);
      expect(logoutExit).toBe(ExitCode.ok);
      expect(stdout.join("")).toContain("logged_out");
      const store = await OAuthTokenStore.open(databasePath, keyProvider);
      expect(await store.load("remote")).toBeUndefined();
      store.close();
    } finally {
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });

  it("reports registry collisions using a code without printing tool descriptions", async () => {
    const peer = await createPeer([
      { name: "duplicated", description: descriptionCanary },
      { name: "duplicated", description: errorCanary },
    ]);
    const { context, stdout, stderr } = createContext(() =>
      Promise.resolve(
        config([
          {
            id: "primary",
            transport: { kind: "stdio", command: "unused" },
          },
        ]),
      ),
    );

    const exitCode = await main(["--json", "servers", "check"], context, [
      createServersCommand({ createTransport: () => Promise.resolve(peer) }),
    ]);
    const result = parseJson(ServersCheckResultSchema, stdout[0] ?? "");

    expect(exitCode).toBe(ExitCode.failure);
    expect(result.errorCode).toBe("tool_id_collision");
    expect(stdout.join("") + stderr.join("")).not.toContain(descriptionCanary);
    expect(stdout.join("") + stderr.join("")).not.toContain(errorCanary);
  });
});
