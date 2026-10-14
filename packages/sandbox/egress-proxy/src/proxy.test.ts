// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { createConnection, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEgressProxy,
  isBlockedEgressAddress,
  startEgressProxy,
  validateEgressAllowlist,
} from "./proxy.js";
import type { EgressCounterEvent, EgressReason } from "./proxy.js";

class EchoDestination extends Socket {
  readonly #reply: string;

  constructor(reply: string) {
    super();
    this.#reply = reply;
    queueMicrotask(() => this.emit("connect"));
  }

  override _read(): void {}

  override _write(
    _chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.push(Buffer.from(this.#reply));
    this.push(null);
    callback();
  }
}

class FailingDestination extends Socket {
  constructor() {
    super();
    queueMicrotask(() => this.destroy(new Error("synthetic destination failure")));
  }

  override _read(): void {}

  override _write(
    _chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    callback();
  }
}

const proxyServers: ReturnType<typeof createEgressProxy>[] = [];
const socketDirectories: string[] = [];

async function makeProxy(options: Parameters<typeof createEgressProxy>[0]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "sandbox-proxy-"));
  socketDirectories.push(directory);
  const socketPath = join(directory, "proxy.sock");
  const server = createEgressProxy({ ...options, socketPath });
  proxyServers.push(server);
  await once(server, "listening");
  return socketPath;
}

async function makeRequest(
  socketPath: string,
  path: string,
  method = "GET",
): Promise<{ readonly status: number | undefined; readonly body: string }> {
  return new Promise((resolve, reject) => {
    const client = request({ socketPath, path, method }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("end", () => {
        resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") });
      });
    });
    client.once("error", reject);
    client.end();
  });
}

async function makeConnectRequest(
  socketPath: string,
  authority: string,
): Promise<{ readonly status: number; readonly body: string }> {
  return new Promise((resolve, reject) => {
    const client = createConnection({ path: socketPath });
    let received = Buffer.alloc(0);
    let status: number | undefined;
    let requestSent = false;
    const finish = (body: string): void => {
      clearTimeout(timeout);
      client.destroy();
      resolve({ status: status ?? 0, body });
    };
    const timeout = setTimeout(() => {
      client.destroy();
      reject(new Error("CONNECT request timed out"));
    }, 1_000);
    client.once("connect", () => {
      client.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    });
    client.on("data", (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      const headerEnd = received.indexOf("\r\n\r\n");
      if (status === undefined && headerEnd >= 0) {
        const header = received.subarray(0, headerEnd).toString("ascii");
        status = Number(/^HTTP\/1\.1 (\d{3})/u.exec(header)?.[1] ?? 0);
        received = received.subarray(headerEnd + 4);
      }
      if (status !== undefined && status !== 200) {
        finish("");
      } else if (status === 200 && !requestSent) {
        requestSent = true;
        client.write("synthetic-connect-data");
      } else if (status === 200 && received.length > 0) {
        finish(received.toString("utf8"));
      }
    });
    client.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(
    proxyServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error === undefined ? resolve() : reject(error)));
        }),
    ),
  );
  await Promise.all(socketDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("egress destination classifier", () => {
  it.each([
    ["10.0.0.1", true],
    ["127.0.0.1", true],
    ["169.254.169.254", true],
    ["172.31.255.255", true],
    ["192.168.1.1", true],
    ["224.0.0.1", true],
    ["8.8.8.8", false],
    ["::", true],
    ["::1", true],
    ["fc00::1", true],
    ["fdff::1", true],
    ["fe80::1", true],
    ["ff02::1", true],
    ["::ffff:169.254.169.254", true],
    ["::ffff:8.8.8.8", false],
    ["2001:4860:4860::8888", false],
  ])("classifies %s", (address, blocked) => {
    expect(isBlockedEgressAddress(address)).toBe(blocked);
  });

  it("rejects invalid addresses", () => {
    expect(isBlockedEgressAddress("not-an-address")).toBe(true);
    expect(isBlockedEgressAddress("2001:4860:4860:0000:0000:0000:0000:8888")).toBe(false);
  });

  it("rejects wildcard and private IP-literal allowlist entries", () => {
    expect(() =>
      validateEgressAllowlist([{ host: "*.example.test", ports: [443] }]),
    ).toThrow();
    expect(() => validateEgressAllowlist([{ host: "10.0.0.1", ports: [443] }])).toThrow();
    expect(() => validateEgressAllowlist([{ host: "api.example.test", ports: [] }])).toThrow();
    expect(() => validateEgressAllowlist([{ host: " api.example.test", ports: [443] }])).toThrow();
    expect(validateEgressAllowlist([{ host: "8.8.8.8", ports: [443] }])).toEqual([
      { host: "8.8.8.8", ports: [443] },
    ]);
  });
});

describe("allowlisted HTTP proxy", () => {
  // threat: T-05
  it("forwards an allowlisted request to the pinned resolver address", async () => {
    const counters: Array<readonly [EgressCounterEvent, EgressReason]> = [];
    const socketPath = await makeProxy({
      allow: [{ host: "allowed.example.test", ports: [80] }],
      resolve: async (hostname) => {
        expect(hostname).toBe("allowed.example.test");
        return ["203.0.113.8"];
      },
      connect: (address, port) => {
        expect(address).toBe("203.0.113.8");
        expect(port).toBe(80);
        return new EchoDestination("HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok");
      },
      counter: (event, reason) => counters.push([event, reason]),
    });
    const result = await makeRequest(
      socketPath,
      "http://allowed.example.test/path?query-canary=do-not-log",
    );
    expect(result).toEqual({ status: 200, body: "ok" });
    expect(counters).toEqual([["egress_allowed", "allowed"]]);
    expect(JSON.stringify(counters)).not.toContain("allowed.example.test");
    expect(JSON.stringify(counters)).not.toContain("query-canary");
  });

  // threat: T-05
  it("rejects an unallowlisted host without resolving or connecting it", async () => {
    let resolverCalled = false;
    let connectorCalled = false;
    const counters: Array<readonly [EgressCounterEvent, EgressReason]> = [];
    const socketPath = await makeProxy({
      allow: [{ host: "allowed.example.test", ports: [80] }],
      resolve: async () => {
        resolverCalled = true;
        return ["203.0.113.8"];
      },
      connect: () => {
        connectorCalled = true;
        return new EchoDestination("");
      },
      counter: (event, reason) => counters.push([event, reason]),
    });
    const result = await makeRequest(socketPath, "http://denied.example.test/secret-path");
    expect(result.status).toBe(403);
    expect(resolverCalled).toBe(false);
    expect(connectorCalled).toBe(false);
    expect(counters).toEqual([["egress_denied", "not_allowlisted"]]);
    expect(JSON.stringify(counters)).not.toContain("denied.example.test");
  });

  // threat: T-06
  it("rejects a DNS answer in a private or metadata range before connecting", async () => {
    let connectorCalled = false;
    const counters: Array<readonly [EgressCounterEvent, EgressReason]> = [];
    const socketPath = await makeProxy({
      allow: [{ host: "allowed.example.test", ports: [80] }],
      resolve: async () => ["169.254.169.254"],
      connect: () => {
        connectorCalled = true;
        return new EchoDestination("");
      },
      counter: (event, reason) => counters.push([event, reason]),
    });
    const result = await makeRequest(socketPath, "http://allowed.example.test/metadata");
    expect(result.status).toBe(502);
    expect(connectorCalled).toBe(false);
    expect(counters).toEqual([["egress_denied", "private_address"]]);
    expect(JSON.stringify(counters)).not.toContain("allowed.example.test");
  });

  it("denies malformed requests, DNS failures, and connection failures with bounded reasons", async () => {
    const reasons: EgressReason[] = [];
    const socketPath = await makeProxy({
      allow: [
        { host: "allowed.example.test", ports: [80] },
        { host: "dns-failure.example.test", ports: [80] },
      ],
      resolve: async (hostname) => {
        if (hostname === "dns-failure.example.test") {
          throw new Error("sensitive resolver message");
        }
        return ["203.0.113.8"];
      },
      connect: () => {
        throw new Error("sensitive connection message");
      },
      counter: (_event, reason) => reasons.push(reason),
    });
    const malformed = await makeRequest(socketPath, "/relative/path");
    const dnsFailure = await makeRequest(socketPath, "http://dns-failure.example.test/");
    const connectFailure = await makeRequest(socketPath, "http://allowed.example.test/");
    expect(malformed.status).toBe(400);
    expect(dnsFailure.status).toBe(502);
    expect(connectFailure.status).toBe(502);
    expect(reasons).toEqual(["invalid_request", "resolution_failed", "connect_failed"]);
    expect(JSON.stringify(reasons)).not.toContain("sensitive");
  });

  // threat: T-06
  it("rejects a private IP literal even when it is present in the allowlist", async () => {
    expect(() => createEgressProxy({ allow: [{ host: "127.0.0.1", ports: [80] }] })).toThrow();
  });

  // threat: T-05
  it("establishes CONNECT tunnels only to allowlisted hosts and ports", async () => {
    const counters: Array<readonly [EgressCounterEvent, EgressReason]> = [];
    const socketPath = await makeProxy({
      allow: [{ host: "allowed.example.test", ports: [443] }],
      resolve: async () => ["203.0.113.8"],
      connect: () => new EchoDestination("synthetic-tunnel-response"),
      counter: (event, reason) => counters.push([event, reason]),
    });
    const accepted = await makeConnectRequest(socketPath, "allowed.example.test:443");
    const denied = await makeConnectRequest(socketPath, "allowed.example.test:8443");
    expect(accepted.status).toBe(200);
    expect(accepted.body).toBe("synthetic-tunnel-response");
    expect(denied.status).toBe(403);
    expect(counters).toEqual([
      ["egress_allowed", "allowed"],
      ["egress_denied", "not_allowlisted"],
    ]);
  });

  // threat: T-06
  it("refuses malformed, metadata, and unconnectable CONNECT destinations", async () => {
    const counters: EgressReason[] = [];
    const socketPath = await makeProxy({
      allow: [
        { host: "metadata.example.test", ports: [443] },
        { host: "allowed.example.test", ports: [443] },
      ],
      resolve: async (hostname) =>
        hostname === "metadata.example.test" ? ["::ffff:169.254.169.254"] : ["203.0.113.8"],
      connect: (address) => {
        if (address === "203.0.113.8") {
          return new FailingDestination();
        }
        return new EchoDestination("");
      },
      counter: (_event, reason) => counters.push(reason),
    });
    const malformed = await makeConnectRequest(socketPath, "not-an-authority");
    const metadata = await makeConnectRequest(socketPath, "metadata.example.test:443");
    const failed = await makeConnectRequest(socketPath, "allowed.example.test:443");
    expect(malformed.status).toBe(400);
    expect(metadata.status).toBe(502);
    expect(failed.status).toBe(502);
    expect(counters).toEqual(["invalid_request", "private_address", "connect_failed"]);
  });

  it("emits only bounded default counter records", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const socketPath = await makeProxy({
      allow: [{ host: "allowed.example.test", ports: [80] }],
      resolve: async () => ["203.0.113.8"],
      connect: () => new EchoDestination(""),
    });
    await makeRequest(socketPath, "http://denied.example.test/private");
    expect(write).toHaveBeenCalledWith(
      `${JSON.stringify({ counter: "egress_denied", reason: "not_allowlisted" })}\n`,
    );
  });

  it("refuses missing, empty, malformed, or invalid-port startup configuration", () => {
    vi.stubEnv("SANDBOX_EGRESS_ALLOW", undefined);
    expect(() => startEgressProxy()).toThrow();
    vi.stubEnv("SANDBOX_EGRESS_ALLOW", "[]");
    expect(() => startEgressProxy()).toThrow();
    vi.stubEnv("SANDBOX_EGRESS_ALLOW", "not-json");
    expect(() => startEgressProxy()).toThrow();
    vi.stubEnv("SANDBOX_EGRESS_ALLOW", '[{"host":"allowed.example.test","ports":[443]}]');
    vi.stubEnv("SANDBOX_EGRESS_PROXY_PORT", "65536");
    expect(() => startEgressProxy()).toThrow();
  });

  it("starts with a validated non-empty allowlist on a local socket", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sandbox-proxy-start-"));
    socketDirectories.push(directory);
    const socketPath = join(directory, "proxy.sock");
    vi.stubEnv("SANDBOX_EGRESS_ALLOW", '[{"host":"allowed.example.test","ports":[443]}]');
    vi.stubEnv("SANDBOX_EGRESS_PROXY_PORT", "3128");
    const server = startEgressProxy({ socketPath });
    proxyServers.push(server);
    await once(server, "listening");
    expect(server.listening).toBe(true);
  });
});
