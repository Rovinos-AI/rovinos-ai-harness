// SPDX-License-Identifier: Apache-2.0
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryTransport, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { HarnessConfigSchema } from "@harness/config";
import { OAuthTokenStore } from "@harness/mcp";
import {
  DoctorResultsSchema,
  parseJson,
  ServersCheckResultSchema,
  type KeyProvider,
} from "@harness/schemas";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { CliContext } from "../command.js";
import { ExitCode } from "../exit-codes.js";
import { createOutput } from "../output.js";
import { main } from "../main.js";
import { createDoctorCommand } from "./doctor.js";
import { createServersCommand } from "./servers.js";
import { LocalKeyProvider } from "@harness/vault";

const descriptionCanary = "servers-check-description-canary";
const errorCanary = "servers-check-error-canary";
const oauthErrorCanary = "oauth-cli-error-description-canary";
const oauthHeaderCanary = "oauth-www-authenticate-canary";
const clientCredentialsExtension = "io.modelcontextprotocol/oauth-client-credentials";
const inputSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

let serverTransports: InMemoryTransport[] = [];
const httpServers: Server[] = [];
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
      stdout: (text) => {
        stdout.push(text);
      },
      stderr: (text) => {
        stderr.push(text);
      },
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
  const chunks: Uint8Array[] = [];
  for await (const chunk of request) {
    if (typeof chunk === "string") {
      chunks.push(new TextEncoder().encode(chunk));
    } else if (chunk instanceof Uint8Array) {
      chunks.push(chunk);
    } else {
      throw new TypeError("invalid HTTP request body chunk");
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function captureConsoleOutput(...args: unknown[]): void {
  capturedConsoleOutput.push(...args);
}

function consoleOutputText(values: readonly unknown[]): string {
  return values
    .map((value) => (typeof value === "string" ? value : JSON.stringify(value)))
    .join(" ");
}

const capturedConsoleOutput: unknown[] = [];

async function createOAuthServer(options: {
  readonly failTokenExchange?: boolean;
  readonly unauthorizedMcp?: boolean;
  readonly requireToken?: boolean;
  readonly clientCredentialsExtension?: boolean;
} = {}) {
  const mcpHandler = createMcpHandler(() => {
    const server = new McpServer({ name: "oauth-mcp-server", version: "1.0.0" });
    server.server.registerCapabilities({
      tools: {},
      ...(options.clientCredentialsExtension === true
        ? { extensions: { [clientCredentialsExtension]: {} } }
        : {}),
    });
    server.server.setRequestHandler("tools/list", () => ({
      tools: [{ name: "listed", inputSchema }],
    }));
    return server;
  }, { legacy: "reject" });
  let unauthorizedMcp = options.unauthorizedMcp === true;
  let issuer = "";
  const server = createServer((request, response) => {
    void (async () => {
      const host = request.headers.host ?? "localhost";
      const url = new URL(request.url ?? "/", `http://${host}`);
      if (request.method === "POST" && url.pathname === "/mcp") {
        if (
          unauthorizedMcp ||
          (options.requireToken === true &&
            request.headers.authorization !== ["Bearer", oauthAccessToken].join(" "))
        ) {
          response
            .writeHead(401, {
              "WWW-Authenticate": [
                "Bearer",
                `error="invalid_token", error_description="${oauthErrorCanary}", realm="${oauthHeaderCanary}", resource_metadata="http://${host}/.well-known/oauth-protected-resource/mcp"`,
              ].join(" "),
            })
            .end();
          return;
        }
        const body = await readRequestBody(request);
        const headers = new Headers();
        for (const [key, value] of Object.entries(request.headers)) {
          if (typeof value === "string") {
            headers.set(key, value);
          } else if (Array.isArray(value)) {
            headers.set(key, value.join(", "));
          }
        }
        const mcpResponse = await mcpHandler.fetch(
          new Request(`${issuer}${url.pathname}${url.search}`, {
            method: request.method,
            headers,
            body,
          }),
        );
        response
          .writeHead(mcpResponse.status, Object.fromEntries(mcpResponse.headers.entries()))
          .end(Buffer.from(await mcpResponse.arrayBuffer()));
        return;
      }
      if (request.method === "GET" && url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
        sendJson(response, {
          resource: `http://${host}/mcp`,
          authorization_servers: [issuer],
          scopes_supported: ["tools:read"],
          ...(options.clientCredentialsExtension === true
            ? { extensions: { [clientCredentialsExtension]: {} } }
            : {}),
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
          z.looseObject({ redirect_uris: z.array(z.url()) }),
          await readRequestBody(request),
        );
        sendJson(response, { ...registration, client_id: "cli-registered-client" });
        return;
      }
      if (request.method === "POST" && url.pathname === "/token") {
        if (options.failTokenExchange === true) {
          response.writeHead(400, {
            "content-type": "application/json",
            "WWW-Authenticate": [
              "Bearer",
              'error="invalid_token"',
              `realm="${oauthHeaderCanary}"`,
            ].join(" "),
          });
          response.end(JSON.stringify({ error: "server_error", error_description: oauthErrorCanary }));
          return;
        }
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
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("OAuth server did not bind a TCP port");
  }
  issuer = `http://127.0.0.1:${String(address.port)}`;
  return {
    issuer,
    setUnauthorized: (value: boolean) => {
      unauthorizedMcp = value;
    },
  };
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
            server.close(() => {
              resolve();
            });
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
    const oauthServer = await createOAuthServer();
    const serverUrl = oauthServer.issuer;
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

      const logoutAfterOpen = await main(["servers", "logout", "remote"], context, [
        createServersCommand(),
      ]);
      expect(logoutAfterOpen).toBe(ExitCode.ok);
      stdout.length = 0;
      openBrowser.mockClear();
      const noOpenLogin = main(["servers", "login", "remote"], context, [
        createServersCommand({ openBrowser }),
      ]);
      await vi.waitFor(() => {
        expect(stdout).toHaveLength(1);
      });
      const authorizationUrlText = stdout[0];
      if (authorizationUrlText === undefined) {
        throw new Error("expected authorization URL output");
      }
      const authorizationUrl = new URL(authorizationUrlText);
      const callback = new URL(authorizationUrl.searchParams.get("redirect_uri") ?? "");
      callback.searchParams.set("code", "cli-no-open-authorization-code");
      callback.searchParams.set("state", authorizationUrl.searchParams.get("state") ?? "");
      callback.searchParams.set("iss", serverUrl);
      expect((await fetch(callback)).status).toBe(200);
      expect(await noOpenLogin).toBe(ExitCode.ok);
      expect(openBrowser).not.toHaveBeenCalled();

      const checkExit = await main(["--json", "servers", "check"], context, [
        createServersCommand(),
      ]);
      const check = parseJson(ServersCheckResultSchema, stdout.at(-1) ?? "");
      expect(checkExit).toBe(ExitCode.ok);
      expect(check.servers).toEqual([
        expect.objectContaining({ id: "remote", reachable: true, toolCount: 1 }),
      ]);

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

  it("authenticates client-credentials servers during servers check and disposes OAuth resources", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "mcp-oauth-client-check-"));
    vi.stubEnv("HARNESS_DATA_DIR", dataDirectory);
    const oauthServer = await createOAuthServer({
      requireToken: true,
      clientCredentialsExtension: true,
    });
    const configWithAuth = HarnessConfigSchema.parse({
      keys: {
        currentKeyId: "primary",
        keys: [{ id: "primary", secret: "env:OAUTH_KEY" }],
      },
      servers: [
        {
          id: "machine",
          transport: {
            kind: "http",
            url: `${oauthServer.issuer}/mcp`,
            auth: {
              kind: "oauth",
              grant: "client_credentials",
              clientId: "machine-client",
              clientSecret: "env:OAUTH_SECRET",
              scopes: ["tools:read"],
            },
          },
        },
      ],
    });
    const { context, stdout } = createContext(() => Promise.resolve(configWithAuth), {
      secretResolver: {
        resolve(reference) {
          if (reference === "env:OAUTH_KEY") {
            return Promise.resolve({ reveal: () => oauthKey.toString("base64") });
          }
          if (reference === "env:OAUTH_SECRET") {
            return Promise.resolve({ reveal: () => "oauth-client-secret" });
          }
          return Promise.reject(new Error("unexpected secret reference"));
        },
      },
    });
    const closeStore = vi.spyOn(OAuthTokenStore.prototype, "close");
    const disposeKeys = vi.spyOn(LocalKeyProvider.prototype, "dispose");
    try {
      const exitCode = await main(["--json", "servers", "check"], context, [
        createServersCommand(),
      ]);
      const result = parseJson(ServersCheckResultSchema, stdout[0] ?? "");

      expect(exitCode).toBe(ExitCode.ok);
      expect(result.servers).toEqual([
        expect.objectContaining({ id: "machine", reachable: true }),
      ]);
      expect(closeStore).toHaveBeenCalledOnce();
      expect(disposeKeys).toHaveBeenCalledOnce();
    } finally {
      closeStore.mockRestore();
      disposeKeys.mockRestore();
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });

  it("reports mcp_auth_required for OAuth servers when encryption keys are absent", async () => {
    const oauthServer = await createOAuthServer({ requireToken: true });
    const configWithoutKeys = HarnessConfigSchema.parse({
      servers: [
        {
          id: "remote",
          transport: {
            kind: "http",
            url: `${oauthServer.issuer}/mcp`,
            auth: { kind: "oauth", grant: "authorization_code" },
          },
        },
      ],
    });
    const { context, stdout } = createContext(() => Promise.resolve(configWithoutKeys));

    const exitCode = await main(["--json", "servers", "check"], context, [
      createServersCommand(),
    ]);
    const result = parseJson(ServersCheckResultSchema, stdout[0] ?? "");

    expect(exitCode).toBe(ExitCode.failure);
    expect(result.servers).toEqual([
      expect.objectContaining({
        id: "remote",
        reachable: false,
        errorCode: "mcp_auth_required",
      }),
    ]);
  });

  it("keeps OAuth error canaries out of console and CLI output during login", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "mcp-oauth-login-failure-"));
    vi.stubEnv("HARNESS_DATA_DIR", dataDirectory);
    const oauthServer = await createOAuthServer({ failTokenExchange: true });
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
            url: `${oauthServer.issuer}/mcp`,
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
      callback.searchParams.set("code", "failed-authorization-code");
      callback.searchParams.set("state", authorizationUrl.searchParams.get("state") ?? "");
      callback.searchParams.set("iss", oauthServer.issuer);
      expect((await fetch(callback)).status).toBe(400);
    });
    capturedConsoleOutput.length = 0;
    const consoleSpies = [
      vi.spyOn(globalThis.console, "warn").mockImplementation(captureConsoleOutput),
      vi.spyOn(globalThis.console, "error").mockImplementation(captureConsoleOutput),
      vi.spyOn(globalThis.console, "log").mockImplementation(captureConsoleOutput),
      vi.spyOn(globalThis.console, "info").mockImplementation(captureConsoleOutput),
      vi.spyOn(globalThis.console, "debug").mockImplementation(captureConsoleOutput),
      vi.spyOn(globalThis.console, "trace").mockImplementation(captureConsoleOutput),
    ];
    try {
      const exitCode = await main(["--json", "servers", "login", "remote", "--open"], context, [
        createServersCommand({ openBrowser }),
      ]);
      const output = stdout.join("") + stderr.join("");
      const consoleOutput = consoleOutputText(capturedConsoleOutput);

      expect(exitCode).toBe(ExitCode.failure);
      expect(openBrowser).toHaveBeenCalledOnce();
      expect(stderr).toContain("mcp_auth_required\n");
      expect(output).not.toContain(oauthErrorCanary);
      expect(output).not.toContain(oauthHeaderCanary);
      expect(consoleOutput).not.toContain(oauthErrorCanary);
      expect(consoleOutput).not.toContain(oauthHeaderCanary);
    } finally {
      for (const spy of consoleSpies) {
        spy.mockRestore();
      }
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });

  it("keeps OAuth challenge canaries out of doctor output", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "mcp-oauth-doctor-"));
    vi.stubEnv("HARNESS_DATA_DIR", dataDirectory);
    vi.stubEnv("OAUTH_KEY", oauthKey.toString("base64"));
    const oauthServer = await createOAuthServer({ unauthorizedMcp: true });
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
            url: `${oauthServer.issuer}/mcp`,
            auth: { kind: "oauth", grant: "authorization_code" },
          },
        },
      ],
    });
    const databasePath = join(dataDirectory, "mcp-oauth.db");
    const store = await OAuthTokenStore.open(databasePath, keyProvider);
    await store.save("remote", {
      issuer: oauthServer.issuer,
      clientInformation: { client_id: "registered-client", issuer: oauthServer.issuer },
      tokens: {
        access_token: "expired-access-token",
        refresh_token: "refresh-token",
        token_type: "Bearer",
        issuer: oauthServer.issuer,
      },
    });
    store.close();
    const { context, stdout, stderr } = createContext(() => Promise.resolve(configWithAuth));
    capturedConsoleOutput.length = 0;
    const consoleSpies = [
      vi.spyOn(globalThis.console, "warn").mockImplementation(captureConsoleOutput),
      vi.spyOn(globalThis.console, "error").mockImplementation(captureConsoleOutput),
      vi.spyOn(globalThis.console, "log").mockImplementation(captureConsoleOutput),
      vi.spyOn(globalThis.console, "info").mockImplementation(captureConsoleOutput),
      vi.spyOn(globalThis.console, "debug").mockImplementation(captureConsoleOutput),
      vi.spyOn(globalThis.console, "trace").mockImplementation(captureConsoleOutput),
    ];
    try {
      const exitCode = await main(["--json", "doctor"], context, [createDoctorCommand()]);
      const results = parseJson(DoctorResultsSchema, stdout[0] ?? "");
      const consoleOutput = consoleOutputText(capturedConsoleOutput);

      expect(exitCode).toBe(ExitCode.failure);
      expect(results).toContainEqual(
        expect.objectContaining({
          id: "servers_authorized",
          status: "fail",
          code: "mcp_connect_failed",
        }),
      );
      expect(stdout.join("") + stderr.join("")).not.toContain(oauthErrorCanary);
      expect(stdout.join("") + stderr.join("")).not.toContain(oauthHeaderCanary);
      expect(consoleOutput).not.toContain(oauthErrorCanary);
      expect(consoleOutput).not.toContain(oauthHeaderCanary);
    } finally {
      for (const spy of consoleSpies) {
        spy.mockRestore();
      }
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
