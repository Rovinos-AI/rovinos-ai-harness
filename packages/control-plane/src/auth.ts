// SPDX-License-Identifier: Apache-2.0
import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { Code, ControlPlaneAuthScopeSchema, HarnessError, Id } from "@harness/schemas";
import type { ControlPlaneConfig, ControlPlaneAuthScope, SecretRef } from "@harness/schemas";
import { emitControlPlaneAudit } from "@harness/telemetry";
import type { AuthInfo, ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";

const DIGEST_BYTES = 32;

const principalSchema = z
  .object({
    tokenId: Code,
    scopes: z.array(ControlPlaneAuthScopeSchema),
    runIds: z.array(Id).optional(),
  })
  .strict();

/** The validated identity and permissions associated with one bearer token. */
export type ControlPlanePrincipal = z.infer<typeof principalSchema>;

/** Metadata-only authentication or tool-call audit record. */
export interface ControlPlaneAudit {
  readonly tokenId: Code;
  readonly tool: Code;
  readonly outcome: Code;
}

/** Receives metadata-only control-plane audit records. */
export type ControlPlaneAuditHandler = (audit: ControlPlaneAudit) => void;

interface ControlPlaneAuthorizationInput<T> {
  readonly context: Pick<ServerContext, "http">;
  readonly tool: Code;
  readonly scope: ControlPlaneAuthScope;
  readonly runId?: Id;
  readonly operation: () => Promise<T>;
  readonly audit?: ControlPlaneAuditHandler;
}

/** Opaque secret value returned by the configured secret resolver. */
export interface ControlPlaneSecret {
  /** Exposes a secret only for authentication or TLS setup. */
  reveal(): string;
}

/** Resolves configured secret references during server startup. */
export interface ControlPlaneSecretResolver {
  /** Resolves one validated secret reference without logging its value. */
  resolve(reference: SecretRef): Promise<ControlPlaneSecret>;
}

/** Closed control-plane startup and authorization errors. */
export class ControlPlaneAuthError extends HarnessError {
  override readonly code:
    | "control_plane_auth_required"
    | "control_plane_auth_invalid"
    | "control_plane_tokens_required"
    | "control_plane_secret_resolver_missing"
    | "control_plane_scope_required"
    | "run_not_found"
    | "control_plane_rate_limited"
    | "control_plane_remote_tls_required"
    | "control_plane_host_invalid";

  constructor(code: ControlPlaneAuthError["code"]) {
    super(code);
    this.code = code;
  }
}

interface ResolvedControlPlaneToken {
  readonly principal: ControlPlanePrincipal;
  readonly digest: Buffer;
}

/** Clock used for deterministic token-bucket rate limiting. */
export interface ControlPlaneClock {
  /** Returns epoch milliseconds. */
  now(): number;
}

/** Resolves configured token secrets once and stores only their SHA-256 digests. */
export async function resolveControlPlaneTokens(
  config: ControlPlaneConfig,
  resolver: ControlPlaneSecretResolver | undefined,
): Promise<ResolvedControlPlaneToken[]> {
  if (config.auth.tokens.length === 0) {
    throw new ControlPlaneAuthError("control_plane_tokens_required");
  }
  if (resolver === undefined) {
    throw new ControlPlaneAuthError("control_plane_secret_resolver_missing");
  }
  return Promise.all(
    config.auth.tokens.map(async ({ id, secret, scopes, runIds }) => {
      const resolved = await resolver.resolve(secret);
      return {
        principal: principalSchema.parse({
          tokenId: id,
          scopes,
          ...(runIds === undefined ? {} : { runIds }),
        }),
        digest: sha256Digest(resolved.reveal()),
      };
    }),
  );
}

/** Computes a SHA-256 digest without retaining the supplied token. */
export function sha256Digest(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

/** Compares a presented token to a precomputed digest with a fixed-size timing-safe comparison. */
export function tokenDigestMatches(token: string, expectedDigest: Uint8Array): boolean {
  const suppliedDigest = sha256Digest(token);
  if (expectedDigest.byteLength !== DIGEST_BYTES) {
    return false;
  }
  return timingSafeEqual(suppliedDigest, expectedDigest);
}

/** Authenticates an Authorization header without revealing which token check failed. */
export function authenticateBearerToken(
  authorization: string | undefined,
  tokens: readonly ResolvedControlPlaneToken[],
): ControlPlanePrincipal | undefined {
  const match = /^Bearer[ \t]+([^ \t]+)$/i.exec(authorization ?? "");
  if (match === null) {
    return undefined;
  }
  const supplied = match[1] ?? "";
  if (supplied.length === 0) {
    return undefined;
  }
  let authenticated: ControlPlanePrincipal | undefined;
  for (const token of tokens) {
    const matches = tokenDigestMatches(supplied, token.digest);
    if (matches && authenticated === undefined) {
      authenticated = token.principal;
    }
  }
  return authenticated;
}

/** Creates the SDK auth context without retaining or forwarding the bearer secret. */
export function toMcpAuthInfo(principal: ControlPlanePrincipal): AuthInfo {
  return {
    token: "control-plane",
    clientId: principal.tokenId,
    scopes: [...principal.scopes],
    extra: { controlPlane: principal },
  };
}

/** Reads a verified control-plane principal from an SDK request context. */
export function controlPlanePrincipal(
  context: Pick<ServerContext, "http">,
): ControlPlanePrincipal | undefined {
  const info = context.http?.authInfo;
  if (info === undefined) {
    return undefined;
  }
  const principal = principalSchema.safeParse(info.extra?.controlPlane);
  if (!principal.success) {
    throw new ControlPlaneAuthError("control_plane_auth_invalid");
  }
  return principal.data;
}

/** Checks whether a principal is permitted to invoke the specified scope. */
export function hasControlPlaneScope(
  principal: ControlPlanePrincipal,
  scope: ControlPlaneAuthScope,
): boolean {
  return principal.scopes.includes("admin") || principal.scopes.includes(scope);
}

/** Requires a caller's scope before loading a scope-protected resource. */
export function requireControlPlaneScope(
  context: Pick<ServerContext, "http">,
  tool: Code,
  scope: ControlPlaneAuthScope,
  audit?: ControlPlaneAuditHandler,
): ControlPlanePrincipal | undefined {
  const principal = controlPlanePrincipal(context);
  if (principal !== undefined && !hasControlPlaneScope(principal, scope)) {
    (audit ?? emitControlPlaneAudit)({
      tokenId: principal.tokenId,
      tool,
      outcome: Code.parse("control_plane_scope_required"),
    });
    throw new ControlPlaneAuthError("control_plane_scope_required");
  }
  return principal;
}

/** Runs a tool operation only when its scope and optional run filter permit it. */
export async function withControlPlaneAuthorization<T>({
  context,
  tool,
  scope,
  runId,
  operation,
  audit,
}: ControlPlaneAuthorizationInput<T>): Promise<T> {
  const principal = controlPlanePrincipal(context);
  if (principal === undefined) {
    return operation();
  }
  const writeAudit = audit ?? emitControlPlaneAudit;
  try {
    if (!hasControlPlaneScope(principal, scope)) {
      throw new ControlPlaneAuthError("control_plane_scope_required");
    }
    if (
      principal.runIds !== undefined &&
      runId !== undefined &&
      !principal.runIds.includes(runId)
    ) {
      throw new ControlPlaneAuthError("run_not_found");
    }
    const result = await operation();
    writeAudit({ tokenId: principal.tokenId, tool, outcome: resultOutcome(result) });
    return result;
  } catch (error) {
    writeAudit({ tokenId: principal.tokenId, tool, outcome: errorOutcome(error) });
    throw error;
  }
}

/** Validates the configured bind host, enforcing TLS for all non-loopback interfaces. */
export function validateControlPlaneBinding(config: ControlPlaneConfig): void {
  if (!isLoopbackHost(config.listen.host) && config.tls === undefined) {
    throw new ControlPlaneAuthError("control_plane_remote_tls_required");
  }
}

/** Validates the request Host allowlist and same-host Origin policy. */
export function validControlPlaneHostOrigin(input: {
  readonly host: string | undefined;
  readonly origin: string | undefined;
  readonly allowedHosts: readonly string[];
  readonly tls: boolean;
}): boolean {
  const requestAuthority = parseAuthority(input.host);
  if (
    requestAuthority === undefined ||
    !input.allowedHosts.some((allowed) => parseHostname(allowed) === requestAuthority.hostname)
  ) {
    return false;
  }
  if (input.origin === undefined) {
    return true;
  }
  try {
    const origin = new URL(input.origin);
    return (
      origin.username === "" &&
      origin.password === "" &&
      origin.pathname === "/" &&
      origin.search === "" &&
      origin.hash === "" &&
      origin.protocol === (input.tls ? "https:" : "http:") &&
      origin.host.toLowerCase() === requestAuthority.authority.toLowerCase()
    );
  } catch {
    return false;
  }
}

/** Per-token token-bucket limiter with an injected clock. */
export class ControlPlaneRateLimiter {
  private readonly buckets = new Map<Code, { tokens: number; updatedAt: number }>();

  /** Creates a limiter with the configured requests-per-minute capacity. */
  constructor(private readonly capacity: number) {}

  /** Consumes one request token, replenishing the bucket at a per-minute rate. */
  tryAcquire(tokenId: Code, now: number): boolean {
    if (!Number.isFinite(now) || now < 0) {
      return false;
    }
    const bucket = this.buckets.get(tokenId) ?? { tokens: this.capacity, updatedAt: now };
    const elapsed = Math.max(0, now - bucket.updatedAt);
    const tokens = Math.min(this.capacity, bucket.tokens + (elapsed * this.capacity) / 60_000);
    if (tokens < 1) {
      this.buckets.set(tokenId, { tokens, updatedAt: Math.max(now, bucket.updatedAt) });
      return false;
    }
    this.buckets.set(tokenId, {
      tokens: tokens - 1,
      updatedAt: Math.max(now, bucket.updatedAt),
    });
    return true;
  }
}

function isLoopbackHost(host: string): boolean {
  const hostname = parseHostname(host);
  if (hostname === undefined) {
    return false;
  }
  const addressType = isIP(hostname);
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    (addressType === 4 && hostname.startsWith("127.")) ||
    (addressType === 6 && hostname === "::1")
  );
}

function parseHostname(value: string): string | undefined {
  const candidate = value.trim().toLowerCase();
  if (candidate.length === 0) {
    return undefined;
  }
  if (isIP(candidate) === 6) {
    return candidate;
  }
  const authority = parseAuthority(candidate);
  return authority?.hostname;
}

function parseAuthority(
  value: string | undefined,
): { readonly hostname: string; readonly authority: string } | undefined {
  if (value === undefined || value.length === 0 || /[/?#@\s]/u.test(value)) {
    return undefined;
  }
  try {
    const parsed = new URL(`http://${value}`);
    if (
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== ""
    ) {
      return undefined;
    }
    return {
      hostname: parsed.hostname.replaceAll(/^\[|\]$/g, "").toLowerCase(),
      authority: parsed.host.toLowerCase(),
    };
  } catch {
    return undefined;
  }
}

function errorOutcome(error: unknown): Code {
  if (typeof error === "object" && error !== null && "code" in error) {
    const parsed = Code.safeParse(error.code);
    if (parsed.success) {
      return parsed.data;
    }
  }
  return Code.parse("tool_failed");
}

function resultOutcome(result: unknown): Code {
  if (typeof result === "object" && result !== null && "isError" in result) {
    if (result.isError === true) {
      const output =
        "structuredContent" in result && typeof result.structuredContent === "object"
          ? result.structuredContent
          : undefined;
      if (output !== undefined && output !== null && "code" in output) {
        const parsed = Code.safeParse(output.code);
        if (parsed.success) {
          return parsed.data;
        }
      }
      return Code.parse("tool_failed");
    }
  }
  return Code.parse("success");
}
