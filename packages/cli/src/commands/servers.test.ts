// SPDX-License-Identifier: Apache-2.0
import { InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { HarnessConfigSchema } from "@harness/config";
import { parseJson, ServersCheckResultSchema } from "@harness/schemas";
import { afterEach, describe, expect, it } from "vitest";
import type { CliContext } from "../command.js";
import { ExitCode } from "../exit-codes.js";
import { createOutput } from "../output.js";
import { main } from "../main.js";
import { createServersCommand } from "./servers.js";

const descriptionCanary = "servers-check-description-canary";
const errorCanary = "servers-check-error-canary";
const inputSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

let serverTransports: InMemoryTransport[] = [];
let toolCalls = 0;

function createContext(loadConfigForTest: CliContext["loadConfig"]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const context: CliContext = {
    loadConfig: loadConfigForTest,
    out: createOutput({
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    }),
    clock: { now: () => 20 },
  };
  return { context, stdout, stderr };
}

async function createPeer(tools?: { name: string; description?: string }[]) {
  const [client, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = new McpServer({ name: errorCanary, version: "1.0.0" });
  server.server.registerCapabilities({
    tools: {},
    extensions: { "io.modelcontextprotocol/ui": {} },
  });
  server.server.setRequestHandler("tools/list", () => ({
    tools: tools?.map((tool) => ({ ...tool, inputSchema })) ?? [
      { name: "available", description: descriptionCanary, inputSchema },
      { name: "filtered", description: errorCanary, inputSchema },
    ],
  }));
  server.server.setRequestHandler("tools/call", () => {
    toolCalls += 1;
    return { content: [{ type: "text", text: errorCanary }] };
  });
  await server.connect(serverTransport);
  serverTransports.push(serverTransport);
  return client;
}

function config(servers?: unknown) {
  return HarnessConfigSchema.parse({ ...(servers === undefined ? {} : { servers }) });
}

afterEach(async () => {
  toolCalls = 0;
  await Promise.all(serverTransports.map((transport) => transport.close()));
  serverTransports = [];
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
