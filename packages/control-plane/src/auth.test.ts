// SPDX-License-Identifier: Apache-2.0
import { Code, ControlPlaneConfigSchema, Id } from "@harness/schemas";
import type { ServerContext } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import {
  authenticateBearerToken,
  ControlPlaneRateLimiter,
  hasControlPlaneScope,
  resolveControlPlaneTokens,
  sha256Digest,
  tokenDigestMatches,
  toMcpAuthInfo,
  validControlPlaneHostOrigin,
  validateControlPlaneBinding,
  withControlPlaneAuthorization,
} from "./auth.js";

const TOKEN_CANARY = "CONTROL_PLANE_TOKEN_CANARY_LONG_ENOUGH";
const RUN_ID = Id.parse("00000000000000000000000001");
const OTHER_RUN_ID = Id.parse("00000000000000000000000002");

function config(scopes: readonly string[] = ["read"], runIds?: readonly string[], tokens = true) {
  return ControlPlaneConfigSchema.parse({
    auth: {
      tokens: tokens
        ? [
            {
              id: "token.test",
              secret: "env:CONTROL_PLANE_TOKEN",
              scopes,
              ...(runIds === undefined ? {} : { runIds }),
            },
          ]
        : [],
    },
  });
}

function resolver(value = TOKEN_CANARY) {
  return {
    resolve: () => Promise.resolve({ reveal: () => value }),
  };
}

async function resolvedTokens(scopes: readonly string[] = ["read"], runIds?: readonly string[]) {
  return resolveControlPlaneTokens(config(scopes, runIds), resolver());
}

function contextWithPrincipal(
  principal: Parameters<typeof toMcpAuthInfo>[0],
): Pick<ServerContext, "http"> {
  return { http: { authInfo: toMcpAuthInfo(principal) } };
}

describe("control-plane authentication", () => {
  it("resolves token references to digests and authenticates valid bearer tokens", async () => {
    const tokens = await resolvedTokens(["read", "approve"], [RUN_ID]);

    expect(authenticateBearerToken(["Be", "arer ", TOKEN_CANARY].join(""), tokens)).toEqual({
      tokenId: "token.test",
      scopes: ["read", "approve"],
      runIds: [RUN_ID],
    });
    expect(JSON.stringify(tokens)).not.toContain(TOKEN_CANARY);
    expect(authenticateBearerToken(["Be", "arer ", "invalid"].join(""), tokens)).toBeUndefined();
    expect(authenticateBearerToken(undefined, tokens)).toBeUndefined();
    expect(authenticateBearerToken("Basic credentials", tokens)).toBeUndefined();
    expect(
      authenticateBearerToken(["Be", "arer ", TOKEN_CANARY, " "].join(""), tokens),
    ).toBeUndefined();
  });

  it("uses the fixed-size SHA-256 timing-safe comparison function", () => {
    const digest = sha256Digest(TOKEN_CANARY);

    expect(digest).toHaveLength(32);
    expect(tokenDigestMatches(TOKEN_CANARY, digest)).toBe(true);
    expect(tokenDigestMatches("different-token", digest)).toBe(false);
    expect(tokenDigestMatches(TOKEN_CANARY, Buffer.alloc(8))).toBe(false);
  });

  it("fails startup when tokens are missing or their resolver is unavailable", async () => {
    await expect(
      resolveControlPlaneTokens(config(["read"], undefined, false), resolver()),
    ).rejects.toMatchObject({
      code: "control_plane_tokens_required",
      message: "control_plane_tokens_required",
    });
    await expect(resolveControlPlaneTokens(config(), undefined)).rejects.toMatchObject({
      code: "control_plane_secret_resolver_missing",
    });
    await expect(resolveControlPlaneTokens(config(), resolver("short"))).rejects.toMatchObject({
      code: "control_plane_token_secret_too_short",
    });
    await expect(
      resolveControlPlaneTokens(config(), resolver("x".repeat(32))),
    ).resolves.toHaveLength(1);
  });
});

describe("control-plane scopes and run filtering", () => {
  it.each([
    { granted: ["read"], required: "read", allowed: true },
    { granted: ["read"], required: "approve", allowed: false },
    { granted: ["approve"], required: "approve", allowed: true },
    { granted: ["approve"], required: "run", allowed: false },
    { granted: ["run"], required: "run", allowed: true },
    { granted: ["read_content"], required: "read_content", allowed: true },
    { granted: ["reveal"], required: "reveal", allowed: true },
    { granted: ["admin"], required: "reveal", allowed: true },
  ] as const)(
    "enforces $required for a token with $granted",
    async ({ granted, required, allowed }) => {
      const [token] = await resolvedTokens(granted);
      if (token === undefined) {
        throw new Error("Missing test token.");
      }
      const operation = vi.fn(() => Promise.resolve("called"));
      const audit = vi.fn();
      const result = await withControlPlaneAuthorization({
        context: contextWithPrincipal(token.principal),
        tool: Code.parse("get_run"),
        scope: required,
        operation,
        audit,
      }).then(
        (value) => ({ status: "success" as const, value }),
        (error: unknown) => ({ status: "error" as const, error }),
      );

      expect(result).toMatchObject(
        allowed
          ? { status: "success", value: "called" }
          : { status: "error", error: { code: "control_plane_scope_required" } },
      );
      expect(operation).toHaveBeenCalledTimes(allowed ? 1 : 0);
      expect(audit).toHaveBeenCalledWith({
        tokenId: Code.parse("token.test"),
        tool: Code.parse("get_run"),
        outcome: Code.parse(allowed ? "success" : "control_plane_scope_required"),
      });
    },
  );

  it.each([
    ["read", true],
    ["read_content", false],
    ["approve", false],
    ["run", false],
    ["reveal", false],
  ] as const)("allows the %s scope only when granted", async (scope, allowed) => {
    const [token] = await resolvedTokens(["read"]);
    if (token === undefined) {
      throw new Error("Missing test token.");
    }
    expect(hasControlPlaneScope(token.principal, scope)).toBe(allowed);
  });

  it.each(["read", "read_content", "approve", "run", "reveal"] as const)(
    "allows admin to use the %s scope",
    async (scope) => {
      const [token] = await resolvedTokens(["admin"]);
      if (token === undefined) {
        throw new Error("Missing test token.");
      }
      expect(hasControlPlaneScope(token.principal, scope)).toBe(true);
    },
  );

  it("refuses missing scopes and runs outside the token filter before tool execution", async () => {
    const [token] = await resolvedTokens(["read"], [RUN_ID]);
    if (token === undefined) {
      throw new Error("Missing test token.");
    }
    const audit = vi.fn();
    const operation = vi.fn(() => Promise.resolve({ structuredContent: { ok: true } }));
    const context = contextWithPrincipal(token.principal);

    await expect(
      withControlPlaneAuthorization({
        context,
        tool: Code.parse("resume_run"),
        scope: "run",
        runId: RUN_ID,
        operation,
        audit,
      }),
    ).rejects.toMatchObject({ code: "control_plane_scope_required" });
    await expect(
      withControlPlaneAuthorization({
        context,
        tool: Code.parse("get_run"),
        scope: "read",
        runId: OTHER_RUN_ID,
        operation,
        audit,
      }),
    ).rejects.toMatchObject({ code: "run_not_found" });

    expect(operation).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledTimes(2);
    expect(audit).toHaveBeenCalledWith({
      tokenId: Code.parse("token.test"),
      tool: Code.parse("get_run"),
      outcome: Code.parse("run_not_found"),
    });
  });

  it("allows only configured runs and audits tool outcomes as codes", async () => {
    const [token] = await resolvedTokens(["read"], [RUN_ID]);
    if (token === undefined) {
      throw new Error("Missing test token.");
    }
    const audit = vi.fn();
    const output = { structuredContent: { ok: true } };

    await expect(
      withControlPlaneAuthorization({
        context: contextWithPrincipal(token.principal),
        tool: Code.parse("get_run"),
        scope: "read",
        runId: RUN_ID,
        operation: () => Promise.resolve(output),
        audit,
      }),
    ).resolves.toBe(output);
    expect(audit).toHaveBeenCalledWith({
      tokenId: Code.parse("token.test"),
      tool: Code.parse("get_run"),
      outcome: Code.parse("success"),
    });

    await expect(
      withControlPlaneAuthorization({
        context: contextWithPrincipal(token.principal),
        tool: Code.parse("get_run"),
        scope: "read",
        runId: RUN_ID,
        operation: () =>
          Promise.resolve({ isError: true, structuredContent: { code: "run_not_found" } }),
        audit,
      }),
    ).resolves.toMatchObject({ isError: true });
    expect(audit).toHaveBeenLastCalledWith({
      tokenId: Code.parse("token.test"),
      tool: Code.parse("get_run"),
      outcome: Code.parse("run_not_found"),
    });
    expect(JSON.stringify(audit.mock.calls)).not.toContain(TOKEN_CANARY);
  });

  it("audits input-required separately and ignores audit sink failures", async () => {
    const [token] = await resolvedTokens(["approve"]);
    if (token === undefined) {
      throw new Error("Missing test token.");
    }
    const audit = vi.fn(() => {
      throw new Error("synthetic audit sink failure");
    });
    const inputRequired = { resultType: "input_required" as const };

    await expect(
      withControlPlaneAuthorization({
        context: contextWithPrincipal(token.principal),
        tool: Code.parse("approve"),
        scope: "approve",
        operation: () => Promise.resolve(inputRequired),
        audit,
      }),
    ).resolves.toBe(inputRequired);

    expect(audit).toHaveBeenCalledOnce();
    expect(audit).toHaveBeenCalledWith({
      tokenId: Code.parse("token.test"),
      tool: Code.parse("approve"),
      outcome: Code.parse("input_required"),
    });
  });

  it("treats an absent auth context as a trusted local stdio call", async () => {
    const operation = vi.fn(() => Promise.resolve("local"));
    const audit = vi.fn();
    const result = await withControlPlaneAuthorization({
      context: {},
      tool: Code.parse("list_runs"),
      scope: "read",
      operation,
      audit,
    });

    expect(result).toBe("local");
    expect(operation).toHaveBeenCalledOnce();
    expect(audit).not.toHaveBeenCalled();
  });

  it("fails closed when SDK auth metadata is malformed", async () => {
    const context = {
      http: {
        authInfo: {
          token: "control-plane",
          clientId: "token.test",
          scopes: ["read"],
          extra: {},
        },
      },
    } satisfies Pick<ServerContext, "http">;

    await expect(
      withControlPlaneAuthorization({
        context,
        tool: Code.parse("list_runs"),
        scope: "read",
        operation: () => Promise.resolve("unreachable"),
      }),
    ).rejects.toMatchObject({ code: "control_plane_auth_invalid" });
  });
});

describe("control-plane network safeguards", () => {
  it("permits loopback binding and requires TLS for remote interfaces", () => {
    expect(() => {
      validateControlPlaneBinding(config());
    }).not.toThrow();
    expect(() => {
      validateControlPlaneBinding(
        ControlPlaneConfigSchema.parse({ listen: { host: "0.0.0.0", port: 3000 } }),
      );
    }).toThrowError("control_plane_remote_tls_required");
    expect(() => {
      validateControlPlaneBinding(
        ControlPlaneConfigSchema.parse({
          listen: { host: "0.0.0.0", port: 3000 },
          tls: { certFile: "file:/cert", keyFile: "file:/key" },
        }),
      );
    }).not.toThrow();
  });

  it.each([
    [{ host: "127.0.0.1:3000", allowedHosts: ["127.0.0.1"] }, true],
    [{ host: "localhost", origin: "http://localhost", allowedHosts: ["localhost"] }, true],
    [{ host: "example.test", allowedHosts: ["localhost"] }, false],
    [{ host: "localhost/", allowedHosts: ["localhost"] }, false],
    [{ host: "localhost", origin: "http://example.test", allowedHosts: ["localhost"] }, false],
    [{ host: "localhost", origin: "http://localhost/path", allowedHosts: ["localhost"] }, false],
    [{ host: "localhost", origin: "https://localhost", allowedHosts: ["localhost"] }, false],
    [{ host: "localhost", origin: "not a URL", allowedHosts: ["localhost"] }, false],
    [{ host: undefined, allowedHosts: ["localhost"] }, false],
    [
      {
        host: "control.example.test:443",
        origin: "https://control.example.test",
        allowedHosts: ["control.example.test"],
        tls: true,
      },
      true,
    ],
    [
      {
        host: "control.example.test:80",
        origin: "https://control.example.test",
        allowedHosts: ["control.example.test"],
        tls: true,
      },
      false,
    ],
  ] as const)("validates allowed Host and same-host Origin values %#", (input, expected) => {
    expect(
      validControlPlaneHostOrigin({
        ...input,
        origin: "origin" in input ? input.origin : undefined,
        allowedHosts: input.allowedHosts,
        tls: "tls" in input ? input.tls : false,
      }),
    ).toBe(expected);
  });

  it("uses a per-token token bucket with an injected clock", () => {
    const limiter = new ControlPlaneRateLimiter(2);
    const first = Code.parse("token.first");
    const second = Code.parse("token.second");

    expect(limiter.tryAcquire(first, 1_000)).toBe(true);
    expect(limiter.tryAcquire(first, 1_000)).toBe(true);
    expect(limiter.tryAcquire(first, 1_000)).toBe(false);
    expect(limiter.tryAcquire(second, 1_000)).toBe(true);
    expect(limiter.tryAcquire(first, 31_000)).toBe(true);
    expect(limiter.tryAcquire(first, 0)).toBe(false);
    expect(limiter.tryAcquire(first, Number.NaN)).toBe(false);
  });
});
