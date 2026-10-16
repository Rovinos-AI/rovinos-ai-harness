// SPDX-License-Identifier: Apache-2.0
import {
  auth,
  type OAuthClientInformationContext,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import { randomBytes, randomInt } from "node:crypto";
import { HarnessError, SecretRefSchema, type ServerConfig } from "@harness/schemas";
import { OAuthTokenStore, type OAuthCredentialRecord } from "./token-store.js";

type HttpTransportConfig = Extract<ServerConfig["transport"], { kind: "http" }>;
type OAuthConfig = NonNullable<HttpTransportConfig["auth"]>;

/** Safe failure raised when a run needs a human to authorize its MCP server. */
export class McpAuthRequiredError extends HarnessError {
  override readonly code = "mcp_auth_required";

  constructor() {
    super("mcp_auth_required");
  }
}

/** Inputs for an issuer-bound MCP OAuth provider. */
export interface McpOAuthProviderOptions {
  /** Configured server id used as the encrypted store key. */
  readonly serverId: string;
  /** Validated HTTP OAuth configuration. */
  readonly auth: OAuthConfig;
  /** Encrypted credential store. */
  readonly tokenStore: OAuthTokenStore;
  /** Redirect URI for an explicit interactive login. */
  readonly redirectUrl?: string;
  /** Resolves the configured client secret reference. */
  readonly resolveSecret: (reference: string) => Promise<string>;
  /** Allows login to redirect the human; runtime connections must leave this disabled. */
  readonly interactive?: boolean;
}

let warningSuppressionDepth = 0;
let originalWarning: Console["warn"] | undefined;

function suppressSdkWarnings(): () => void {
  const consoleObject = globalThis["console"];
  if (warningSuppressionDepth === 0) {
    originalWarning = consoleObject["warn"];
    const warning = originalWarning;
    const redactingWarning: typeof warning = (...args) => {
      const firstArgument = args[0];
      if (typeof firstArgument === "string" && firstArgument.startsWith("[mcp-sdk]")) {
        return;
      }
      Reflect.apply(warning, consoleObject, args);
    };
    if (!Reflect.set(consoleObject, "warn", redactingWarning)) {
      originalWarning = undefined;
      throw new McpAuthRequiredError();
    }
  }
  warningSuppressionDepth += 1;
  return () => {
    warningSuppressionDepth -= 1;
    if (warningSuppressionDepth === 0 && originalWarning !== undefined) {
      Reflect.set(consoleObject, "warn", originalWarning);
      originalWarning = undefined;
    }
  };
}

/**
 * Executes SDK authentication while suppressing its warnings, which may contain remote error text.
 *
 * @param operation - SDK action that can emit OAuth warnings.
 * @returns The operation's result without forwarding SDK warning text.
 */
export async function withOAuthWarningsRedacted<Result>(
  operation: () => Promise<Result>,
): Promise<Result> {
  const restore = suppressSdkWarnings();
  try {
    return await operation();
  } finally {
    restore();
  }
}

/** OAuthClientProvider backed by the encrypted per-server credential store. */
export class McpOAuthProvider implements OAuthClientProvider {
  readonly clientMetadataUrl?: string;
  readonly #serverId: string;
  readonly #config: OAuthConfig;
  readonly #store: OAuthTokenStore;
  readonly #interactive: boolean;
  readonly #redirectUrl: string | undefined;
  readonly #clientSecret: string | undefined;
  #record: OAuthCredentialRecord;
  #discovery: OAuthDiscoveryState | undefined;
  #authorizationUrl: URL | undefined;

  private constructor(options: McpOAuthProviderOptions, record: OAuthCredentialRecord, secret?: string) {
    this.#serverId = options.serverId;
    this.#config = options.auth;
    if (options.auth.clientIdMetadataUrl !== undefined) {
      this.clientMetadataUrl = options.auth.clientIdMetadataUrl;
    }
    this.#store = options.tokenStore;
    this.#interactive = options.interactive === true;
    this.#record = record;
    this.#clientSecret = secret;
    this.#redirectUrl =
      options.redirectUrl ??
      record.redirectUrl ??
      (options.auth.grant === "client_credentials"
        ? undefined
        : `http://127.0.0.1:${String(options.auth.redirectPort ?? randomInt(49_152, 65_536))}/oauth/callback`);
  }

  /**
   * Loads encrypted state and resolves the optional configured client secret in memory.
   *
   * @param options - Provider configuration and secure store dependencies.
   * @returns The provider for one MCP server.
   */
  static async create(options: McpOAuthProviderOptions): Promise<McpOAuthProvider> {
    const record = (await options.tokenStore.load(options.serverId)) ?? {};
    const secretRef = options.auth.clientSecret;
    let secret: string | undefined;
    if (secretRef !== undefined) {
      const parsed = SecretRefSchema.safeParse(secretRef);
      if (!parsed.success) {
        throw new McpAuthRequiredError();
      }
      try {
        secret = await options.resolveSecret(parsed.data);
      } catch {
        throw new McpAuthRequiredError();
      }
    }
    return new McpOAuthProvider(options, record, secret);
  }

  /** Authorization URL generated by the SDK during an explicit login. */
  get authorizationUrl(): URL | undefined {
    return this.#authorizationUrl;
  }

  /** Loopback redirect URI, absent for client-credentials flows. */
  get redirectUrl(): string | undefined {
    return this.#config.grant === "client_credentials" ? undefined : this.#redirectUrl;
  }

  /** Client registration metadata used by SDK discovery and DCR fallback. */
  get clientMetadata(): OAuthClientMetadata {
    const grantTypes =
      this.#config.grant === "client_credentials"
        ? ["client_credentials"]
        : ["authorization_code", "refresh_token"];
    return {
      redirect_uris: this.redirectUrl === undefined ? [] : [this.redirectUrl],
      grant_types: grantTypes,
      response_types: this.#config.grant === "client_credentials" ? [] : ["code"],
      token_endpoint_auth_method: this.#clientSecret === undefined ? "none" : "client_secret_basic",
      application_type: "native",
      client_name: "Rovinos AI Harness",
      ...(this.#config.scopes === undefined ? {} : { scope: this.#config.scopes.join(" ") }),
    };
  }

  /** Returns the stable state value for an authorization callback. */
  async state(): Promise<string> {
    if (this.#record.state !== undefined) {
      return this.#record.state;
    }
    const state = randomBytes(32).toString("base64url");
    await this.#save({ ...this.#record, state });
    return state;
  }

  /** Returns credentials only when the discovered issuer matches their stored issuer. */
  async clientInformation(
    context?: OAuthClientInformationContext,
  ): Promise<StoredOAuthClientInformation | undefined> {
    const issuer = context?.issuer;
    if (issuer === undefined) {
      return this.#record.clientInformation;
    }
    if (this.#record.issuer === issuer) {
      return this.#record.clientInformation;
    }
    if (this.#record.issuer !== undefined || this.#config.clientId === undefined) {
      return undefined;
    }
    const information: StoredOAuthClientInformation = {
      client_id: this.#config.clientId,
      ...(this.#clientSecret === undefined ? {} : { client_secret: this.#clientSecret }),
      issuer,
    };
    await this.saveClientInformation(information, context);
    return information;
  }

  /** Saves registration credentials with the authorization-server issuer. */
  async saveClientInformation(
    information: StoredOAuthClientInformation,
    context?: OAuthClientInformationContext,
  ): Promise<void> {
    const issuer = context?.issuer ?? information.issuer;
    if (issuer === undefined) {
      throw new McpAuthRequiredError();
    }
    await this.#save({
      ...this.#record,
      issuer,
      clientInformation: { ...information, issuer },
    });
  }

  /** Returns tokens only for the matching issuer, or the most recently stored tokens to transports. */
  tokens(context?: OAuthClientInformationContext): StoredOAuthTokens | undefined {
    if (context?.issuer !== undefined && context.issuer !== this.#record.issuer) {
      return undefined;
    }
    return this.#record.tokens;
  }

  /** Stores SDK tokens with their validated issuer. */
  async saveTokens(tokens: StoredOAuthTokens, context?: OAuthClientInformationContext): Promise<void> {
    const issuer = context?.issuer ?? tokens.issuer;
    if (issuer === undefined) {
      throw new McpAuthRequiredError();
    }
    await this.#save({ ...this.#record, issuer, tokens: { ...tokens, issuer } });
  }

  /** Captures the SDK authorization URL or refuses to start an interactive run-time flow. */
  redirectToAuthorization(authorizationUrl: URL): void {
    if (!this.#interactive) {
      throw new McpAuthRequiredError();
    }
    this.#authorizationUrl = authorizationUrl;
  }

  /** Persists the PKCE verifier before leaving for the user's browser. */
  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await this.#save({ ...this.#record, codeVerifier });
  }

  /** Returns the persisted PKCE verifier for the authorization callback. */
  codeVerifier(): string {
    if (this.#record.codeVerifier === undefined) {
      throw new McpAuthRequiredError();
    }
    return this.#record.codeVerifier;
  }

  /** Selects the SDK client-credentials grant for configured machine-to-machine servers. */
  prepareTokenRequest(scope?: string): URLSearchParams | undefined {
    if (this.#config.grant !== "client_credentials") {
      return undefined;
    }
    const parameters = new URLSearchParams({ grant_type: "client_credentials" });
    const requestedScope = scope ?? this.#config.scopes?.join(" ");
    if (requestedScope !== undefined && requestedScope.length > 0) {
      parameters.set("scope", requestedScope);
    }
    return parameters;
  }

  /** Persists discovery state in memory for issuer validation across the login redirect. */
  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    this.#discovery = state;
    const issuer = state.authorizationServerMetadata?.issuer ?? state.authorizationServerUrl;
    await this.#save({ ...this.#record, issuer });
  }

  /** Returns discovery metadata retained for the current process. */
  discoveryState(): OAuthDiscoveryState | undefined {
    return this.#discovery;
  }

  /** Deletes cached tokens, client registrations, PKCE state, or discovery metadata. */
  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    if (scope === "all") {
      this.#store.delete(this.#serverId);
      this.#record = {};
      this.#discovery = undefined;
      return;
    }
    const next = { ...this.#record };
    if (scope === "client") {
      delete next.clientInformation;
    } else if (scope === "tokens") {
      delete next.tokens;
    } else if (scope === "verifier") {
      delete next.codeVerifier;
      delete next.state;
    } else {
      this.#discovery = undefined;
    }
    await this.#save(next);
  }

  /** Runs OAuth discovery using the SDK without exposing its server-derived warning messages. */
  async beginAuthorization(serverUrl: URL): Promise<"AUTHORIZED" | "REDIRECT"> {
    await this.#save({ ...this.#record, state: randomBytes(32).toString("base64url") });
    return withOAuthWarningsRedacted(() =>
      auth(this, {
        serverUrl,
        ...(this.#config.scopes === undefined ? {} : { scope: this.#config.scopes.join(" ") }),
      }),
    );
  }

  async #save(record: OAuthCredentialRecord): Promise<void> {
    this.#record = record;
    await this.#store.save(this.#serverId, record);
  }
}
