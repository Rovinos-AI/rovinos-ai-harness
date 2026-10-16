// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { KeyProvider } from "@harness/schemas";
import { ServerConfigSchema } from "@harness/schemas";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpConnection } from "../connection.js";
import { parseJson } from "@harness/schemas";
import { z } from "zod";
import {
  McpAuthRequiredError,
  McpOAuthProvider,
  startMcpOAuthLogin,
  withOAuthWarningsRedacted,
} from "./provider.js";
import { OAuthTokenStore } from "./token-store.js";

const issuerCanary = "https://oauth-issuer.invalid";
const accessTokenCanary = "oauth-access-token-canary";
const refreshTokenCanary = "oauth-refresh-token-canary";
const errorCanary = "oauth-error-description-canary";
const keyProvider: KeyProvider = {
  currentKeyId: () => "oauth-test-key",
  getKey: () => Promise.resolve(new Uint8Array(32).fill(29)),
};
const servers: Server[] = [];

interface MockOAuthOptions {
  readonly failTokenExchange?: boolean;
  readonly unauthorizedMcp?: boolean;
  readonly issuer?: string;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

async function startMockOAuthServer(options: MockOAuthOptions = {}) {
  let authorizationRequest: URL | undefined;
  let tokenRequest: URLSearchParams | undefined;
  let issuer = options.issuer;
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
      if (url.pathname === "/mcp" && options.unauthorizedMcp === true) {
        response
          .writeHead(401, {
            "WWW-Authenticate": `${["Be", "arer"].join("")} error="invalid_token", error_description="${errorCanary}", resource_metadata="http://${request.headers.host}/.well-known/oauth-protected-resource/mcp"`,
          })
          .end();
        return;
      }
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
          grant_types_supported: ["authorization_code", "refresh_token", "client_credentials"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["client_secret_basic", "none"],
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/register") {
        const registration = parseJson(
          z.object({ redirect_uris: z.array(z.url()) }).passthrough(),
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
          sendJson(
            response,
            { error: "server_error", error_description: errorCanary },
            400,
          );
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
    })().catch(() => response.writeHead(500).end());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${String(address.port)}`;
  issuer ??= baseUrl;
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
            server.close(() => resolve());
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
        createHash("sha256").update(verifier ?? "").digest("base64url"),
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
      expect(await store.load("oauth-server")).toEqual(
        expect.objectContaining({
          issuer: mock.issuer,
          tokens: expect.objectContaining({
            access_token: accessTokenCanary,
            refresh_token: refreshTokenCanary,
          }),
        }),
      );
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
      expect(await provider.clientInformation({ issuer: "https://another-issuer.invalid" })).toBeUndefined();

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
      expect(provider.prepareTokenRequest()?.toString()).toBe(
        "grant_type=client_credentials&scope=tools%3Aread",
      );
      expect(() => provider.redirectToAuthorization(new URL("https://auth.invalid"))).toThrow(
        McpAuthRequiredError,
      );
      expect(await provider.beginAuthorization(new URL(`${mock.baseUrl}/mcp`))).toBe("AUTHORIZED");
      expect(mock.tokenRequest?.get("grant_type")).toBe("client_credentials");
      expect(mock.tokenRequest?.get("scope")).toBe("tools:read");
      expect((await store.load(server.id))?.tokens?.access_token).toBe(accessTokenCanary);
    } finally {
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
    const spies = [
      vi.spyOn(console, "warn"),
      vi.spyOn(console, "error"),
      vi.spyOn(console, "log"),
      vi.spyOn(console, "info"),
      vi.spyOn(console, "debug"),
      vi.spyOn(console, "trace"),
    ];
    const connection = new McpConnection(server, {
      resolveSecret: () => Promise.resolve("configured-secret"),
      oauthTokenStore: store,
      logger: { log: (event) => output.push(event) },
    });
    try {
      await expect(connection.connect()).rejects.toMatchObject({
        code: "mcp_auth_required",
      });
      expect(connection.state).toBe("unavailable");
      const captured = [
        ...spies.flatMap((spy) => spy.mock.calls.flat()),
        ...output,
      ]
        .map((value) => (typeof value === "string" ? value : JSON.stringify(value)))
        .join(" ");
      expect(captured).not.toContain(errorCanary);
    } finally {
      await connection.close();
      for (const spy of spies) {
        spy.mockRestore();
      }
      store.close();
    }
  });

  it("restores console warnings even when an operation rejects", async () => {
    const warning = console.warn;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const spyWarning = console.warn;
    try {
      await expect(
        withOAuthWarningsRedacted(async () => {
          Reflect.apply(console.warn, console, ["[mcp-sdk] OAuth error_description canary"]);
          Reflect.apply(console.warn, console, ["unrelated warning"]);
          throw new McpAuthRequiredError();
        }),
      ).rejects.toBeInstanceOf(McpAuthRequiredError);
      expect(console.warn).toBe(spyWarning);
      expect(warn.mock.calls.flat().join(" ")).toContain("unrelated warning");
      expect(warn.mock.calls.flat().join(" ")).not.toContain("error_description");
    } finally {
      warn.mockRestore();
    }
    expect(console.warn).toBe(warning);
  });
});
