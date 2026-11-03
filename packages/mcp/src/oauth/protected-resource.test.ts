// SPDX-License-Identifier: Apache-2.0
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OAuthDiscoveryConfig } from "@rovinos/schemas";
import { isAllowedOAuthDiscoveryDestination } from "./discovery-policy.js";
import {
  MAX_OAUTH_DISCOVERY_BYTES,
  MAX_OAUTH_DISCOVERY_REDIRECTS,
  MAX_OAUTH_DISCOVERY_TIMEOUT_MS,
} from "./discovery-transport.js";
import {
  OAUTH_CLIENT_CREDENTIALS_EXTENSION,
  resourceAdvertisesClientCredentials,
} from "./protected-resource.js";

const servers: Server[] = [];
const localPolicy: OAuthDiscoveryConfig = { profile: "local-development" };

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          if (!server.listening) {
            resolve();
            return;
          }
          server.close(() => resolve());
        }),
    ),
  );
});

async function listen(
  handle: (request: IncomingMessage, response: ServerResponse) => void,
  bindHost = "127.0.0.1",
): Promise<{ readonly baseUrl: string; readonly server: Server }> {
  const server = createServer(handle);
  servers.push(server);
  server.listen(0, bindHost);
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("OAuth discovery test server failed to listen.");
  }
  return { baseUrl: `http://localhost:${String(address.port)}`, server };
}

function localResolver(hostname: string): (host: string) => Promise<readonly string[]> {
  return async (host) => {
    if (host === hostname || host === "localhost") {
      return ["127.0.0.1"];
    }
    return ["93.184.216.34"];
  };
}

function metadataResponse(response: ServerResponse): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ extensions: { [OAUTH_CLIENT_CREDENTIALS_EXTENSION]: {} } }));
}

describe("OAuth discovery network profiles", () => {
  it("allows public HTTPS by default and lets an exact allowlist narrow production", () => {
    const url = new URL("https://mcp.example.test/mcp");
    const production: OAuthDiscoveryConfig = { profile: "production" };
    expect(isAllowedOAuthDiscoveryDestination(url, production, ["93.184.216.34"])).toBe(true);
    expect(
      isAllowedOAuthDiscoveryDestination(
        url,
        { profile: "production", allowlist: [{ host: "other.example.test", ports: [443] }] },
        ["93.184.216.34"],
      ),
    ).toBe(false);
  });

  it.each([
    ["loopback", "127.0.0.1"],
    ["private IPv4", "10.1.2.3"],
    ["link-local metadata", "169.254.169.254"],
    ["IPv4-mapped loopback", "::ffff:7f00:1"],
    ["IPv4-mapped private", "::ffff:a00:1"],
    ["dotted IPv4-mapped private", "::ffff:10.0.0.1"],
    ["unspecified", "0.0.0.0"],
    ["multicast", "224.0.0.1"],
    ["IPv6 unique-local", "fd00::1"],
    ["IPv6 link-local", "fe80::1"],
    ["Teredo transition", "2001::1"],
    ["IPv6 documentation", "2001:db8::1"],
  ])("denies %s addresses in production", (_label, address) => {
    expect(
      isAllowedOAuthDiscoveryDestination(
        new URL("https://mcp.example.test"),
        { profile: "production" },
        [address],
      ),
    ).toBe(false);
  });

  it("permits explicitly allowlisted private addresses only in the internal profile", () => {
    const policy: OAuthDiscoveryConfig = {
      profile: "internal",
      allowlist: [{ host: "mcp.internal.test", ports: [443] }],
    };
    expect(
      isAllowedOAuthDiscoveryDestination(
        new URL("https://mcp.internal.test"),
        policy,
        ["10.1.2.3"],
      ),
    ).toBe(true);
    expect(
      isAllowedOAuthDiscoveryDestination(
        new URL("https://mcp.internal.test"),
        policy,
        ["10.1.2.3", "169.254.169.254"],
      ),
    ).toBe(false);
  });

  it("limits the local-development profile to loopback HTTP", () => {
    expect(
      isAllowedOAuthDiscoveryDestination(
        new URL("http://localhost:8080"),
        { profile: "local-development" },
        ["127.0.0.1"],
      ),
    ).toBe(true);
    expect(
      isAllowedOAuthDiscoveryDestination(
        new URL("http://mcp.example.test:8080"),
        { profile: "local-development" },
        ["127.0.0.1"],
      ),
    ).toBe(false);
    expect(
      isAllowedOAuthDiscoveryDestination(
        new URL("https://mcp.example.test"),
        { profile: "local-development" },
        ["10.1.2.3"],
      ),
    ).toBe(false);
  });

  it("rejects a mixed DNS answer set when any answer is disallowed", () => {
    expect(
      isAllowedOAuthDiscoveryDestination(
        new URL("https://mcp.example.test"),
        { profile: "production" },
        ["93.184.216.34", "127.0.0.1"],
      ),
    ).toBe(false);
  });
});

describe("resourceAdvertisesClientCredentials", () => {
  it("uses the advertised metadata URL without forwarding credentials", async () => {
    const seenHeaders: IncomingMessage["headers"][] = [];
    const { baseUrl } = await listen((request, response) => {
      seenHeaders.push(request.headers);
      if (request.url === "/mcp") {
        response.writeHead(401, {
          "www-authenticate": ["Bearer", `resource_metadata="http://${request.headers.host}/metadata"`].join(" "),
        });
        response.end();
        return;
      }
      metadataResponse(response);
    });
    const url = new URL(baseUrl);
    const host = url.hostname;
    const port = Number(url.port);

    await expect(
      resourceAdvertisesClientCredentials(
        `${baseUrl}/mcp`,
        undefined,
        {
          profile: "local-development",
          allowlist: [{ host, ports: [port] }],
        },
        { resolve: localResolver(host) },
      ),
    ).resolves.toBe(true);
    expect(seenHeaders).toHaveLength(2);
    expect(seenHeaders.every((headers) => headers.authorization === undefined)).toBe(true);
    expect(seenHeaders.every((headers) => headers.cookie === undefined)).toBe(true);
  });

  it("uses the well-known URL when the challenge has no resource_metadata", async () => {
    const paths: string[] = [];
    const { baseUrl } = await listen((request, response) => {
      paths.push(request.url ?? "");
      metadataResponse(response);
    });
    const host = new URL(baseUrl).hostname;

    await expect(
      resourceAdvertisesClientCredentials(
        `${baseUrl}/mcp`,
        undefined,
        localPolicy,
        { resolve: localResolver(host) },
      ),
    ).resolves.toBe(true);
    expect(paths).toEqual(["/mcp", "/.well-known/oauth-protected-resource/mcp"]);
  });

  it("preserves the protected-resource redirect regression from issue 244", async () => {
    const paths: string[] = [];
    const { baseUrl } = await listen((request, response) => {
      const path = request.url ?? "";
      paths.push(path);
      if (path === "/mcp") {
        response.writeHead(308, { location: "/mcp/" });
        response.end();
        return;
      }
      if (path === "/mcp/") {
        response.writeHead(401, {
          "www-authenticate": ["Bearer", `resource_metadata="http://${request.headers.host}/metadata"`].join(" "),
        });
        response.end();
        return;
      }
      metadataResponse(response);
    });
    const host = new URL(baseUrl).hostname;

    await expect(
      resourceAdvertisesClientCredentials(
        `${baseUrl}/mcp`,
        undefined,
        localPolicy,
        { resolve: localResolver(host) },
      ),
    ).resolves.toBe(true);
    expect(paths).toEqual(["/mcp", "/mcp/", "/metadata"]);
  });

  it("blocks a malicious redirect while allowing a same-origin redirect negative control", async () => {
    let maliciousDestinationRequests = 0;
    const { baseUrl } = await listen((request, response) => {
      if (request.url === "/mcp") {
        response.writeHead(401, {
          "www-authenticate": ["Bearer", `resource_metadata="http://${request.headers.host}/metadata"`].join(" "),
        });
        response.end();
        return;
      }
      if (request.url === "/metadata") {
        response.writeHead(302, {
          location: `http://attacker.test:${String(new URL(baseUrl).port)}/steal`,
        });
        response.end();
        return;
      }
      if (request.url === "/steal") {
        maliciousDestinationRequests += 1;
      }
      metadataResponse(response);
    });
    const host = new URL(baseUrl).hostname;
    const policy: OAuthDiscoveryConfig = {
      profile: "local-development",
      allowlist: [{ host, ports: [Number(new URL(baseUrl).port)] }],
    };
    const resolve = vi.fn(localResolver(host));
    const probe = (path: string) =>
      resourceAdvertisesClientCredentials(`${baseUrl}${path}`, undefined, policy, { resolve });

    await expect(probe("/mcp")).resolves.toBe(false);
    expect(maliciousDestinationRequests).toBe(0);

    const { baseUrl: controlUrl } = await listen((request, response) => {
      if (request.url === "/mcp") {
        response.writeHead(401, {
          "www-authenticate": ["Bearer", `resource_metadata="http://${request.headers.host}/metadata"`].join(" "),
        });
        response.end();
        return;
      }
      if (request.url === "/metadata") {
        response.writeHead(302, { location: "/metadata-final" });
        response.end();
        return;
      }
      metadataResponse(response);
    });
    const controlHost = new URL(controlUrl).hostname;
    await expect(
      resourceAdvertisesClientCredentials(
        `${controlUrl}/mcp`,
        undefined,
        {
          profile: "local-development",
          allowlist: [{ host: controlHost, ports: [Number(new URL(controlUrl).port)] }],
        },
        { resolve: localResolver(controlHost) },
      ),
    ).resolves.toBe(true);
  });

  it("enforces the redirect cap", async () => {
    let requests = 0;
    const { baseUrl } = await listen((_request, response) => {
      requests += 1;
      response.writeHead(302, { location: "/loop" });
      response.end();
    });
    const host = new URL(baseUrl).hostname;

    await expect(
      resourceAdvertisesClientCredentials(
        `${baseUrl}/mcp`,
        undefined,
        localPolicy,
        { resolve: localResolver(host) },
      ),
    ).resolves.toBe(false);
    expect(requests).toBe(MAX_OAUTH_DISCOVERY_REDIRECTS + 1);
  });

  it("pins the socket to the single validated DNS answer", async () => {
    let requests = 0;
    const { baseUrl } = await listen((_request, response) => {
      requests += 1;
      metadataResponse(response);
    });
    const hostname = "oauth-pin.invalid";
    const resolver = vi.fn(async () => ["127.0.0.1"]);

    await expect(
      resourceAdvertisesClientCredentials(
        baseUrl.replace("localhost", hostname),
        undefined,
        {
          profile: "local-development",
          allowlist: [{ host: hostname, ports: [Number(new URL(baseUrl).port)] }],
        },
        { resolve: resolver },
      ),
    ).resolves.toBe(true);
    expect(resolver).toHaveBeenCalledTimes(2);
    expect(requests).toBe(2);
  });

  it("bounds chunked metadata bodies without a Content-Length", async () => {
    const { baseUrl } = await listen((request, response) => {
      if (request.url === "/mcp") {
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(Buffer.alloc(MAX_OAUTH_DISCOVERY_BYTES + 1, 0x20));
    });
    const host = new URL(baseUrl).hostname;

    await expect(
      resourceAdvertisesClientCredentials(
        `${baseUrl}/mcp`,
        undefined,
        localPolicy,
        { resolve: localResolver(host) },
      ),
    ).rejects.toThrow("protected_resource_probe_failed");
  });

  it("cancels the metadata body read when the caller aborts", async () => {
    let started: (() => void) | undefined;
    const bodyStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const { baseUrl } = await listen((request, response) => {
      if (request.url === "/mcp") {
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.write("{");
      started?.();
    });
    const host = new URL(baseUrl).hostname;
    const controller = new AbortController();
    const probe = resourceAdvertisesClientCredentials(
      `${baseUrl}/mcp`,
      controller.signal,
      localPolicy,
      { resolve: localResolver(host) },
    );

    await bodyStarted;
    controller.abort();
    await expect(probe).rejects.toMatchObject({ name: "AbortError" });
  });

  it("stops a DNS lookup at the total operation deadline", async () => {
    vi.useFakeTimers();
    const probe = resourceAdvertisesClientCredentials(
      "https://mcp.example.test/mcp",
      undefined,
      { profile: "production" },
      { resolve: () => new Promise<readonly string[]>(() => undefined) },
    );
    const assertion = expect(probe).rejects.toThrow("protected_resource_probe_failed");
    await vi.advanceTimersByTimeAsync(MAX_OAUTH_DISCOVERY_TIMEOUT_MS);
    await assertion;
  });

  it("cancels DNS resolution when the caller aborts", async () => {
    const controller = new AbortController();
    const probe = resourceAdvertisesClientCredentials(
      "https://mcp.example.test/mcp",
      controller.signal,
      { profile: "production" },
      { resolve: () => new Promise<readonly string[]>(() => undefined) },
    );
    controller.abort();
    await expect(probe).rejects.toMatchObject({ name: "AbortError" });
  });
});
