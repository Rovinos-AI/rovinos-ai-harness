// SPDX-License-Identifier: Apache-2.0
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { SecretRef, ServerConfig } from "@rovinos/schemas";
import { McpAuthRequiredError, McpOAuthProvider, withOAuthWarningsRedacted } from "./provider.js";
import type { OAuthTokenStore } from "./token-store.js";

/** Active explicit-login flow with a loopback callback and no implicit browser launch. */
export interface McpOAuthLoginSession {
  /** Authorization URL to display to the user. */
  readonly authorizationUrl: string;
  /** Loopback callback URL registered for this login. */
  readonly redirectUrl: string;
  /** Resolves after issuer-validated callback parameters are exchanged for tokens. */
  readonly complete: Promise<void>;
  /** Stops the loopback listener and closes the temporary SDK transport. */
  close(): Promise<void>;
}

/** Inputs for the explicit HTTP-server authorization-code login flow. */
export interface McpOAuthLoginOptions {
  /** Validated server configuration. */
  readonly server: ServerConfig;
  /** Encrypted credential store. */
  readonly tokenStore: OAuthTokenStore;
  /** Resolves a configured client secret reference. */
  readonly resolveSecret: (reference: SecretRef) => Promise<string>;
}

interface LoginCallback {
  readonly complete: Promise<void>;
  readonly resolve: () => void;
  readonly reject: () => void;
}

async function closeCallbackServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

async function createCallbackServer(
  port?: number,
): Promise<{ server: Server; redirectUrl: string }> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", () => {
      reject(new McpAuthRequiredError());
    });
    server.listen(port ?? 0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeCallbackServer(server);
    throw new McpAuthRequiredError();
  }
  return {
    server,
    redirectUrl: `http://127.0.0.1:${String(address.port)}/oauth/callback`,
  };
}

function createLoginCallback(): LoginCallback {
  let resolveCallback: () => void = () => undefined;
  let rejectCallback: () => void = () => undefined;
  const complete = new Promise<void>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = () => {
      reject(new McpAuthRequiredError());
    };
  });
  void complete.catch(() => undefined);
  return { complete, resolve: resolveCallback, reject: rejectCallback };
}

async function handleAuthorizationCallback(options: {
  readonly requestUrl: string | undefined;
  readonly method: string | undefined;
  readonly response: ServerResponse;
  readonly redirectUrl: string;
  readonly expectedState: string | undefined;
  readonly transport: StreamableHTTPClientTransport;
  readonly callback: LoginCallback;
}): Promise<void> {
  let callbackUrl: URL;
  try {
    callbackUrl = new URL(options.requestUrl ?? "/", options.redirectUrl);
  } catch {
    options.response.writeHead(400).end("Invalid authorization response.");
    return;
  }
  if (options.method !== "GET" || callbackUrl.pathname !== "/oauth/callback") {
    options.response.writeHead(404).end("Not found.");
    return;
  }
  if (
    options.expectedState === undefined ||
    callbackUrl.searchParams.get("state") !== options.expectedState
  ) {
    options.response.writeHead(400).end("Invalid authorization response.");
    return;
  }
  try {
    await withOAuthWarningsRedacted(() => options.transport.finishAuth(callbackUrl.searchParams));
    options.response
      .writeHead(200, { "content-type": "text/plain; charset=utf-8" })
      .end("Authorization complete. Return to the harness CLI.");
    options.callback.resolve();
  } catch {
    options.response.writeHead(400).end("Authorization failed.");
    options.callback.reject();
  }
}

/**
 * Starts an OAuth 2.1 authorization-code flow on an IPv4 loopback callback.
 *
 * The caller decides whether to open the returned URL. The SDK receives the full callback
 * parameters so it can validate the RFC 9207 `iss` value before exchanging the code.
 *
 * @param options - Server configuration, encrypted token store, and client-secret resolver.
 * @returns Session containing the authorization URL and callback completion promise.
 */
export async function startMcpOAuthLogin(
  options: McpOAuthLoginOptions,
): Promise<McpOAuthLoginSession> {
  const transportConfig = options.server.transport;
  if (transportConfig.kind !== "http" || transportConfig.auth?.grant !== "authorization_code") {
    throw new McpAuthRequiredError();
  }
  const { server: callbackServer, redirectUrl } = await createCallbackServer(
    transportConfig.auth.redirectPort,
  );
  let provider: McpOAuthProvider;
  let transport: StreamableHTTPClientTransport;
  try {
    provider = await McpOAuthProvider.create({
      serverId: options.server.id,
      auth: transportConfig.auth,
      tokenStore: options.tokenStore,
      resolveSecret: options.resolveSecret,
      redirectUrl,
      interactive: true,
    });
    transport = new StreamableHTTPClientTransport(new URL(transportConfig.url), {
      authProvider: provider,
    });
  } catch {
    await closeCallbackServer(callbackServer);
    throw new McpAuthRequiredError();
  }

  const callback = createLoginCallback();
  let expectedState: string | undefined;
  callbackServer.on("request", (request, response) => {
    void handleAuthorizationCallback({
      requestUrl: request.url,
      method: request.method,
      response,
      redirectUrl,
      expectedState,
      transport,
      callback,
    });
  });
  try {
    const result = await provider.beginAuthorization(new URL(transportConfig.url));
    expectedState = await provider.state();
    if (result === "AUTHORIZED") {
      callback.resolve();
      await closeCallbackServer(callbackServer);
      return {
        authorizationUrl: "",
        redirectUrl,
        complete: callback.complete,
        close: () => transport.close(),
      };
    }
    const authorizationUrl = provider.authorizationUrl;
    if (authorizationUrl === undefined) {
      throw new McpAuthRequiredError();
    }
    return {
      authorizationUrl: authorizationUrl.toString(),
      redirectUrl,
      complete: callback.complete,
      close: async () => {
        await closeCallbackServer(callbackServer);
        await transport.close();
      },
    };
  } catch {
    await closeCallbackServer(callbackServer);
    await transport.close();
    throw new McpAuthRequiredError();
  }
}
