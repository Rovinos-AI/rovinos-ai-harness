// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { checkElicitationUrl, redactUrlCredentials } from "./url.js";

describe("redactUrlCredentials", () => {
  it("removes synthetic userinfo without changing the URL policy decision", () => {
    const url = new URL("https://example.test/account?flow=synthetic");
    url.username = "synthetic-user";
    url.password = "synthetic-password";
    expect(checkElicitationUrl(url.href)).toEqual({ accepted: false, reason: "credentials" });
    expect(redactUrlCredentials(url.href)).toBe("https://example.test/account?flow=synthetic");
  });

  it("preserves credential-free URLs byte for byte", () => {
    const url = "https://EXAMPLE.test/%41?flow=synthetic#fragment";
    expect(redactUrlCredentials(url)).toBe(url);
  });
});

describe("checkElicitationUrl", () => {
  it.each(["javascript:alert(1)", "data:text/plain,hello", "file:///etc/passwd"])(
    "rejects the %s scheme",
    (url) => {
      expect(checkElicitationUrl(url)).toEqual({ accepted: false, reason: "scheme" });
    },
  );

  it("rejects URL usernames and passwords, including empty userinfo", () => {
    const url = new URL("https://example.test/path");
    url.username = "user";
    url.password = "pass";
    expect(checkElicitationUrl(url.toString())).toEqual({
      accepted: false,
      reason: "credentials",
    });
    expect(checkElicitationUrl("https://@example.test/path")).toEqual({
      accepted: false,
      reason: "credentials",
    });
  });

  it("requires HTTPS for non-loopback HTTP URLs by default", () => {
    expect(checkElicitationUrl("http://example.test")).toEqual({
      accepted: false,
      reason: "https_required",
    });
  });

  it("requires an allowlist entry for an IP-literal loopback host", () => {
    expect(checkElicitationUrl("http://127.0.0.1")).toEqual({
      accepted: false,
      reason: "ip_literal",
    });
  });

  it.each([
    ["http://localhost", undefined],
    ["http://127.0.0.1", { urlAllowHosts: ["127.0.0.1"] }],
  ] as const)("requires HTTPS by default for %s", (url, options) => {
    expect(checkElicitationUrl(url, options)).toEqual({
      accepted: false,
      reason: "https_required",
    });
  });

  it("allows HTTP only for loopback when HTTPS is disabled", () => {
    expect(checkElicitationUrl("http://localhost:8080", { requireHttps: false })).toEqual({
      accepted: true,
      suspicious: false,
    });
    expect(checkElicitationUrl("http://example.test", { requireHttps: false })).toEqual({
      accepted: false,
      reason: "https_required",
    });
    expect(checkElicitationUrl("https://[::1]/path", { urlAllowHosts: ["[::1]"] })).toEqual({
      accepted: true,
      suspicious: false,
    });
  });

  it.each(["https://127.0.0.1", "https://[::1]"])(
    "rejects a non-allowlisted IP literal in %s",
    (url) => {
      expect(checkElicitationUrl(url)).toEqual({ accepted: false, reason: "ip_literal" });
    },
  );

  it("allows an explicitly allowlisted IP literal", () => {
    expect(checkElicitationUrl("https://127.0.0.1/path", { urlAllowHosts: ["127.0.0.1"] })).toEqual(
      { accepted: true, suspicious: false },
    );
  });

  it("matches the optional host allowlist exactly", () => {
    expect(
      checkElicitationUrl("https://sub.example.test", { urlAllowHosts: ["example.test"] }),
    ).toEqual({ accepted: false, reason: "host_not_allowed" });
    expect(
      checkElicitationUrl("https://EXAMPLE.test/path", { urlAllowHosts: ["example.test"] }),
    ).toEqual({ accepted: true, suspicious: false });
  });

  it("flags internationalized and mixed-script hostnames", () => {
    expect(checkElicitationUrl("https://xn--e1afmkfd.example")).toEqual({
      accepted: true,
      suspicious: true,
    });
    expect(checkElicitationUrl("https://раypal.example")).toEqual({
      accepted: true,
      suspicious: true,
    });
  });

  it("rejects malformed URLs", () => {
    expect(checkElicitationUrl("not a URL")).toEqual({ accepted: false, reason: "invalid" });
  });

  it("does not fetch or open accepted URLs", () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    try {
      expect(checkElicitationUrl("https://example.test/path")).toEqual({
        accepted: true,
        suspicious: false,
      });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });
});
