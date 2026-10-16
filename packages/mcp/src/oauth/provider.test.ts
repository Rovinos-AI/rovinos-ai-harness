// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { parseJson, ServerConfigSchema } from "@harness/schemas";
import type { KeyProvider } from "@harness/schemas";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpConnection } from "../connection.js";
import { z } from "zod";
import { McpAuthRequiredError, McpOAuthProvider, withOAuthWarningsRedacted } from "./provider.js";
import { startMcpOAuthLogin } from "./login.js";
import { OAuthTokenStore } from "./token-store.js";

const issuerCanary = "https://oauth-issuer.invalid";
const accessTokenCanary = "oauth-access-token-canary";
const refreshTokenCanary = "oauth-refresh-token-canary";
const errorCanary = "oauth-error-description-canary";
const headerCanary = "oauth-www-authenticate-canary";
const capturedConsoleOutput: unknown[] = [];
const keyProvider: KeyProvider = {
  currentKeyId: () => "oauth-test-key",
  getKey: () => Promise.resolve(new Uint8Array(32).fill(29)),
};
const servers: Server[] = [];

function captureConsoleOutput(...args: unknown[]): void {
  capturedConsoleOutput.push(...args);
}

function consoleOutputText(values: readonly unknown[]): string {
  return values
    .map((value) => (typeof value === "string" ? value : JSON.stringify(value)))
    .join(" ");
}

interface MockOAuthOptions {
  readonly failTokenExchange?: boolean;
  readonly unauthorizedMcp?: boolean;
  readonly issuer?: string;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(bufferFromChunk(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function bufferFromChunk(chunk: unknown): Buffer {
  if (typeof chunk === "string" || chunk instanceof Uint8Array) {
    return Buffer.from(chunk);
  }
  throw new Error("invalid HTTP request body chunk");
}

function sendJson(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

async function startMockOAuthServer(options: MockOAuthOptions = {}) {
  let authorizationRequest: URL | undefined;
  let tokenRequest: URLSearchParams | undefined;
  let issuer = options.issuer ?? "";
  const server = createServer((request, response) => {
    void (async () => {
      const host = request.headers.host ?? "127.0.0.1";
      const url = new URL(request.url ?? "/", `http://${host}`);
      if (url.pathname === "/mcp" && options.unauthorizedMcp === true) {
        response
          .writeHead(401, {
            "WWW-Authenticate": `bearer error="invalid_token", error_description="${errorCanary}", realm="${headerCanary}", resource_metadata="http://${host}/.well-known/oauth-protected-resource/mcp"`,
          })
          .end();
        return;
      }
      if (
        request.method === "GET" &&
        url.pathname.startsWith("/.well-known/oauth-protected-resource")
      ) {
        sendJson(response, {
          resource: `http://${host}/mcp`,
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
          grant_types_supported: ["authorization_code", "refresh_token", "client_credentials"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["client_secret_basic", "none"],
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/register") {
        const registration = parseJson(
          z.looseObject({ redirect_uris: z.array(z.url()) }),
          await readBody(request),
        );
        sendJson(response, {
          ...registration,
          client_id: "registered-client",
          client_secret: "registered-secret",
          token_endpoint_auth_method: "client_secret_basic",
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/authorize") {
        authorizationRequest = url;
        response.writeHead(204).end();
        return;
      }
      if (request.method === "POST" && url.pathname === "/token") {
        tokenRequest = new URLSearchParams(await readBody(request));
        if (options.failTokenExchange === true) {
          sendJson(response, { error: "server_error", error_description: errorCanary }, 400);
          return;
        }
        sendJson(response, {
          access_token: accessTokenCanary,
          refresh_token: refreshTokenCanary,
          token_type: "Bearer",
          expires_in: 3600,
          scope: "tools:read",
        });
        return;
      }
      response.writeHead(404).end();
    })().catch(() => {
      response.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.push(server);
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("OAuth server did not bind a TCP port");
  }
  const baseUrl = `http://127.0.0.1:${String(address.port)}`;
  issuer = issuer.length > 0 ? issuer : baseUrl;
  return {
    baseUrl,
    issuer,
    get authorizationRequest() {
      return authorizationRequest;
    },
    get tokenRequest() {
      return tokenRequest;
    },
  };
}

function serverConfig(
  baseUrl: string,
  auth: {
    readonly grant: "authorization_code" | "client_credentials";
    readonly clientId?: string;
    readonly clientSecret?: string;
    readonly scopes?: string[];
    readonly redirectPort?: number;
  } = { grant: "authorization_code" },
) {
  return ServerConfigSchema.parse({
    id: "oauth-server",
    transport: {
      kind: "http",
      url: `${baseUrl}/mcp`,
      auth: {
        kind: "oauth",
        ...auth,
        ...(auth.clientSecret === undefined ? {} : { clientSecret: "env:OAUTH_SECRET" }),
      },
    },
  });
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
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
});

describe("McpOAuthProvider", () => {
  it("performs issuer-bound authorization-code login with PKCE and stores tokens", async () => {
    const mock = await startMockOAuthServer();
    const store = await OAuthTokenStore.open(":memory:", keyProvider);
    const configuration = serverConfig(mock.baseUrl);
    const session = await startMcpOAuthLogin({
      server: configuration,
      tokenStore: store,
      resolveSecret: () => Promise.resolve("configured-secret"),
    });
    try {
      const authorizationUrl = new URL(session.authorizationUrl);
      expect(authorizationUrl.origin).toBe(mock.issuer);
      expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
      expect(authorizationUrl.searchParams.get("resource")).toBe(`${mock.baseUrl}/mcp`);
      const verifier = (await store.load("oauth-server"))?.codeVerifier;
      expect(verifier).toBeDefined();
      expect(
        createHash("sha256")
          .update(verifier ?? "")
          .digest("base64url"),
      ).toBe(authorizationUrl.searchParams.get("code_challenge"));
      expect(mock.authorizationRequest).toBeUndefined();

      const callback = new URL(session.redirectUrl);
      callback.searchParams.set("code", "authorization-code");
      callback.searchParams.set("state", authorizationUrl.searchParams.get("state") ?? "");
      callback.searchParams.set("iss", mock.issuer);
      const invalidCallback = new URL(callback);
      invalidCallback.searchParams.set("state", "invalid-state");
      expect((await fetch(invalidCallback)).status).toBe(400);
      const response = await fetch(callback);
      expect(response.status).toBe(200);
      await session.complete;

      expect(mock.tokenRequest?.get("grant_type")).toBe("authorization_code");
      expect(mock.tokenRequest?.get("code_verifier")).toBe(verifier);
      const stored = await store.load("oauth-server");
      expect(stored?.issuer).toBe(mock.issuer);
      expect(stored?.tokens?.access_token).toBe(accessTokenCanary);
      expect(stored?.tokens?.refresh_token).toBe(refreshTokenCanary);
    } finally {
      await session.close();
      store.close();
    }
  });

  it("maps OAuth callback failures to safe codes and suppresses SDK warning canaries", async () => {
    const mock = await startMockOAuthServer({ failTokenExchange: true });
    const store = await OAuthTokenStore.open(":memory:", keyProvider);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const session = await startMcpOAuthLogin({
      server: serverConfig(mock.baseUrl),
      tokenStore: store,
      resolveSecret: () => Promise.resolve("configured-secret"),
    });
    try {
      const authorizationUrl = new URL(session.authorizationUrl);
      const callback = new URL(session.redirectUrl);
      callback.searchParams.set("code", "authorization-code");
      callback.searchParams.set("state", authorizationUrl.searchParams.get("state") ?? "");
      callback.searchParams.set("iss", mock.issuer);
      const response = await fetch(callback);
      expect(response.status).toBe(400);
      await expect(session.complete).rejects.toBeInstanceOf(McpAuthRequiredError);
      expect(warn.mock.calls.flat().join(" ")).not.toContain(errorCanary);
      expect(warn.mock.calls.flat().join(" ")).not.toContain(accessTokenCanary);
    } finally {
      warn.mockRestore();
      await session.close();
      store.close();
    }
  });

  it("refuses an authorization callback with a different issuer", async () => {
    const mock = await startMockOAuthServer();
    const store = await OAuthTokenStore.open(":memory:", keyProvider);
    const session = await startMcpOAuthLogin({
      server: serverConfig(mock.baseUrl),
      tokenStore: store,
      resolveSecret: () => Promise.resolve("configured-secret"),
    });
    try {
      const authorizationUrl = new URL(session.authorizationUrl);
      const callback = new URL(session.redirectUrl);
      callback.searchParams.set("code", "authorization-code");
      callback.searchParams.set("state", authorizationUrl.searchParams.get("state") ?? "");
      callback.searchParams.set("iss", "https://different-issuer.invalid");
      expect((await fetch(callback)).status).toBe(400);
      await expect(session.complete).rejects.toBeInstanceOf(McpAuthRequiredError);
      expect(mock.tokenRequest).toBeUndefined();
    } finally {
      await session.close();
      store.close();
    }
  });

  it("binds stored registration and tokens to the discovered issuer", async () => {
    const store = await OAuthTokenStore.open(":memory:", keyProvider);
    const server = serverConfig("http://127.0.0.1:3000", {
      grant: "authorization_code",
      clientId: "configured-client",
      clientSecret: "env:OAUTH_SECRET",
    });
    if (server.transport.kind !== "http" || server.transport.auth === undefined) {
      throw new Error("invalid OAuth test configuration");
    }
    const provider = await McpOAuthProvider.create({
      serverId: server.id,
      auth: server.transport.auth,
      tokenStore: store,
      resolveSecret: () => Promise.resolve("configured-secret"),
    });
    try {
      const information = await provider.clientInformation({ issuer: issuerCanary });
      expect(information).toEqual(
        expect.objectContaining({
          client_id: "configured-client",
          client_secret: "configured-secret",
          issuer: issuerCanary,
        }),
      );
      await provider.saveTokens(
        { access_token: accessTokenCanary, token_type: "Bearer" },
        { issuer: issuerCanary },
      );
      expect(provider.tokens({ issuer: issuerCanary })?.access_token).toBe(accessTokenCanary);
      expect(provider.tokens({ issuer: "https://another-issuer.invalid" })).toBeUndefined();
      expect(
        await provider.clientInformation({ issuer: "https://another-issuer.invalid" }),
      ).toBeUndefined();

      await provider.saveCodeVerifier("pkce-verifier");
      expect(provider.codeVerifier()).toBe("pkce-verifier");
      expect(await provider.state()).toHaveLength(43);
      expect(provider.prepareTokenRequest()).toBeUndefined();
      await provider.invalidateCredentials("verifier");
      expect(() => provider.codeVerifier()).toThrow(McpAuthRequiredError);
      await provider.invalidateCredentials("tokens");
      expect(provider.tokens()).toBeUndefined();
      await provider.invalidateCredentials("all");
      expect(await store.load(server.id)).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("clears issuer A credentials when discovery switches to issuer B", async () => {
    const store = await OAuthTokenStore.open(":memory:", keyProvider);
    const server = serverConfig("http://127.0.0.1:3000");
    if (server.transport.kind !== "http" || server.transport.auth === undefined) {
      throw new Error("invalid OAuth test configuration");
    }
    const provider = await McpOAuthProvider.create({
      serverId: server.id,
      auth: server.transport.auth,
      tokenStore: store,
      resolveSecret: () => Promise.resolve("configured-secret"),
    });
    try {
      await provider.saveClientInformation(
        { client_id: "issuer-a-client", issuer: issuerCanary },
        { issuer: issuerCanary },
      );
      await provider.saveTokens(
        { access_token: accessTokenCanary, token_type: "Bearer", issuer: issuerCanary },
        { issuer: issuerCanary },
      );
      await provider.saveCodeVerifier("issuer-a-verifier");
      await provider.state();

      const issuerB = "https://different-issuer.invalid";
      await provider.saveDiscoveryState({ authorizationServerUrl: issuerB });

      expect(provider.tokens({ issuer: issuerB })).toBeUndefined();
      expect(await provider.clientInformation({ issuer: issuerB })).toBeUndefined();
      const stored = await store.load(server.id);
      expect(stored?.issuer).toBeUndefined();
      expect(stored?.clientInformation).toBeUndefined();
      expect(stored?.tokens).toBeUndefined();
      expect(stored?.codeVerifier).toBeUndefined();
      expect(stored?.state).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("reuses configured client information after cached registration invalidation", async () => {
    const store = await OAuthTokenStore.open(":memory:", keyProvider);
    const server = serverConfig("http://127.0.0.1:3000", {
      grant: "authorization_code",
      clientId: "configured-client",
      clientSecret: "env:OAUTH_SECRET",
    });
    if (server.transport.kind !== "http" || server.transport.auth === undefined) {
      throw new Error("invalid OAuth test configuration");
    }
    const provider = await McpOAuthProvider.create({
      serverId: server.id,
      auth: server.transport.auth,
      tokenStore: store,
      resolveSecret: () => Promise.resolve("configured-secret"),
    });
    try {
      const initial = await provider.clientInformation({ issuer: issuerCanary });
      await provider.invalidateCredentials("client");

      expect(await provider.clientInformation({ issuer: issuerCanary })).toEqual(initial);
    } finally {
      store.close();
    }
  });

  it("prepares client-credentials grants and refuses interactive runtime redirects", async () => {
    const mock = await startMockOAuthServer();
    const store = await OAuthTokenStore.open(":memory:", keyProvider);
    const server = serverConfig(mock.baseUrl, {
      grant: "client_credentials",
      clientId: "service-client",
      clientSecret: "env:OAUTH_SECRET",
      scopes: ["tools:read"],
    });
    if (server.transport.kind !== "http" || server.transport.auth === undefined) {
      throw new Error("invalid OAuth test configuration");
    }
    const provider = await McpOAuthProvider.create({
      serverId: server.id,
      auth: server.transport.auth,
      tokenStore: store,
      resolveSecret: () => Promise.resolve("configured-secret"),
    });
    try {
      expect(provider.redirectUrl).toBeUndefined();
      expect(provider.clientMetadata.grant_types).toEqual(["client_credentials"]);
      expect(() => provider.prepareTokenRequest()).toThrow(McpAuthRequiredError);
      expect(mock.tokenRequest).toBeUndefined();
      provider.setClientCredentialsExtensionEnabled(true);
      expect(decodeURIComponent(provider.prepareTokenRequest()?.toString() ?? "")).toBe(
        "grant_type=client_credentials&scope=tools:read",
      );
      expect(() => {
        provider.redirectToAuthorization(new URL("https://auth.invalid"));
      }).toThrow(McpAuthRequiredError);
      expect(await provider.beginAuthorization(new URL(`${mock.baseUrl}/mcp`))).toBe("AUTHORIZED");
      expect(mock.tokenRequest?.get("grant_type")).toBe("client_credentials");
      expect(mock.tokenRequest?.get("scope")).toBe("tools:read");
      expect((await store.load(server.id))?.tokens?.access_token).toBe(accessTokenCanary);
    } finally {
      store.close();
    }
  });

  it("does not request a client-credentials token before the server advertises the extension", async () => {
    const mock = await startMockOAuthServer({ unauthorizedMcp: true });
    const store = await OAuthTokenStore.open(":memory:", keyProvider);
    const server = serverConfig(mock.baseUrl, {
      grant: "client_credentials",
      clientId: "service-client",
      clientSecret: "env:OAUTH_SECRET",
      scopes: ["tools:read"],
    });
    const connection = new McpConnection(server, {
      resolveSecret: () => Promise.resolve("configured-secret"),
      oauthTokenStore: store,
    });
    try {
      await expect(connection.connect()).rejects.toMatchObject({
        code: "mcp_auth_required",
      });
      expect(mock.tokenRequest).toBeUndefined();
    } finally {
      await connection.close();
      store.close();
    }
  });

  it("refreshes a stored authorization-code session without interactive login", async () => {
    const mock = await startMockOAuthServer();
    const store = await OAuthTokenStore.open(":memory:", keyProvider);
    const server = serverConfig(mock.baseUrl);
    if (server.transport.kind !== "http" || server.transport.auth === undefined) {
      throw new Error("invalid OAuth test configuration");
    }
    const provider = await McpOAuthProvider.create({
      serverId: server.id,
      auth: server.transport.auth,
      tokenStore: store,
      resolveSecret: () => Promise.resolve("configured-secret"),
    });
    try {
      await provider.saveClientInformation(
        {
          client_id: "registered-client",
          client_secret: "registered-secret",
          issuer: mock.issuer,
        },
        { issuer: mock.issuer },
      );
      await provider.saveTokens(
        {
          access_token: "expired-access-token",
          refresh_token: refreshTokenCanary,
          token_type: "Bearer",
          issuer: mock.issuer,
        },
        { issuer: mock.issuer },
      );
      expect(await provider.beginAuthorization(new URL(`${mock.baseUrl}/mcp`))).toBe("AUTHORIZED");
      expect(mock.tokenRequest?.get("grant_type")).toBe("refresh_token");
      expect(mock.tokenRequest?.get("refresh_token")).toBe(refreshTokenCanary);
      expect((await store.load(server.id))?.tokens?.access_token).toBe(accessTokenCanary);
    } finally {
      store.close();
    }
  });

  it("maps an OAuth challenge to mcp_auth_required without exposing its canary", async () => {
    const mock = await startMockOAuthServer({ unauthorizedMcp: true });
    const store = await OAuthTokenStore.open(":memory:", keyProvider);
    const server = serverConfig(mock.baseUrl);
    const output: unknown[] = [];
    capturedConsoleOutput.length = 0;
    const spies = [
      vi.spyOn(globalThis.console, "warn").mockImplementation(captureConsoleOutput),
      vi.spyOn(globalThis.console, "error").mockImplementation(captureConsoleOutput),
      vi.spyOn(globalThis.console, "log").mockImplementation(captureConsoleOutput),
      vi.spyOn(globalThis.console, "info").mockImplementation(captureConsoleOutput),
      vi.spyOn(globalThis.console, "debug").mockImplementation(captureConsoleOutput),
      vi.spyOn(globalThis.console, "trace").mockImplementation(captureConsoleOutput),
    ];
    const connection = new McpConnection(server, {
      resolveSecret: () => Promise.resolve("configured-secret"),
      oauthTokenStore: store,
      logger: {
        log: (event) => {
          output.push(event);
        },
      },
    });
    try {
      await expect(connection.connect()).rejects.toMatchObject({
        code: "mcp_auth_required",
      });
      expect(connection.state).toBe("unavailable");
      const captured = consoleOutputText([...capturedConsoleOutput, ...output]);
      expect(captured).not.toContain(errorCanary);
      expect(captured).not.toContain(headerCanary);
    } finally {
      await connection.close();
      for (const spy of spies) {
        spy.mockRestore();
      }
      store.close();
    }
  });

  it("suppresses all auth-path warnings and errors, then restores the console", async () => {
    const consoleObject = globalThis.console;
    const warning = consoleObject.warn;
    const errorOutput = consoleObject.error;
    const warn = vi.spyOn(consoleObject, "warn").mockImplementation(captureConsoleOutput);
    const error = vi.spyOn(consoleObject, "error").mockImplementation(captureConsoleOutput);
    const spyWarning = consoleObject.warn;
    const spyError = consoleObject.error;
    try {
      await expect(
        withOAuthWarningsRedacted(() =>
          Promise.resolve().then(() => {
            consoleObject.warn({ message: errorCanary });
            consoleObject.error(`x ${errorCanary}`);
            throw new McpAuthRequiredError();
          }),
        ),
      ).rejects.toBeInstanceOf(McpAuthRequiredError);
      expect(consoleObject.warn).toBe(spyWarning);
      expect(consoleObject.error).toBe(spyError);
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
    expect(consoleObject.warn).toBe(warning);
    expect(consoleObject.error).toBe(errorOutput);
  });

  it("suppresses auth-context console output without dropping concurrent application warnings", async () => {
    const output: unknown[] = [];
    const warn = vi.spyOn(globalThis.console, "warn").mockImplementation((...args: unknown[]) => {
      output.push(...args);
    });
    try {
      const authOperation = withOAuthWarningsRedacted(
        () =>
          new Promise<void>((resolve) => {
            setTimeout(() => {
              globalThis.console.warn(errorCanary);
              resolve();
            }, 10);
          }),
      );
      globalThis.console.warn("unrelated-application-warning");
      await authOperation;

      expect(output).toContain("unrelated-application-warning");
      expect(output).not.toContain(errorCanary);
    } finally {
      warn.mockRestore();
    }
  });
});
