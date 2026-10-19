// SPDX-License-Identifier: Apache-2.0
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { Id, parseJson, type NewEvent } from "@harness/schemas";
import { SqliteEventStore } from "@harness/store-sqlite";
import { z } from "zod";

const root = resolvePath(import.meta.dirname, "../..");
const harness = resolvePath(root, "packages/cli/dist/bin.js");
const inspector = resolvePath(
  root,
  "node_modules/@modelcontextprotocol/inspector/clients/launcher/build/index.js",
);
const objectSchema = z.record(z.string(), z.unknown());
const protocolVersions = { modern: "2026-07-28", legacy: "2025-11-25" } as const;
const appTools = ["harness.approvals.resolve", "harness.approvals.reveal"] as const;

interface ProcessResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface RunningServer {
  readonly child: ChildProcess;
  readonly endpoint: string;
  readonly close: () => Promise<void>;
}

interface InspectorRequest {
  readonly transport: "stdio" | "http";
  readonly endpoint: string | undefined;
  readonly protocolEra: "modern" | "legacy";
  readonly method: string;
  readonly env: NodeJS.ProcessEnv;
  readonly flags?: readonly string[];
}

function failure(message: string, code = "inspector_conformance_failed"): never {
  throw new Error(`${message}\n${JSON.stringify({ error: { code } })}`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  const parsed = objectSchema.safeParse(value);
  return parsed.success ? parsed.data : failure(`${label} was not an object.`);
}

function jsonObject(text: string, label: string): Record<string, unknown> {
  try {
    return parseJson(objectSchema, text.trim());
  } catch {
    return failure(`${label} did not return a JSON object.`);
  }
}

function inspectorError(result: ProcessResult, label: string): never {
  const reasons: Record<number, string> = {
    3: "authentication failed",
    4: "server was unreachable",
    5: "MCP tool error",
    6: "strict schema portability check failed",
  };
  const detail =
    result.stderr.trim().length > 0
      ? result.stderr.trim()
      : JSON.stringify({ error: { code: `inspector_exit_${String(result.status)}` } });
  throw new Error(`${label}: ${reasons[result.status] ?? "Inspector failed"}\n${detail}`);
}

function runProcess(args: readonly string[], env: NodeJS.ProcessEnv): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [inspector, "--cli", ...args], {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      settled = true;
      reject(new Error("Inspector command timed out."));
    }, 30_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", (error: Error) => {
      clearTimeout(timeout);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.once("close", (status) => {
      clearTimeout(timeout);
      if (!settled) {
        settled = true;
        resolve({ status: status ?? -1, stdout, stderr });
      }
    });
  });
}

function minimalEnvironment(home: string, configPath: string, dataDir: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "",
    HOME: home,
    USERPROFILE: home,
    HARNESS_CONFIG: configPath,
    HARNESS_DATA_DIR: dataDir,
    MCP_INSPECTOR_SECRET_STORE: "memory",
    MCP_STORAGE_DIR: join(home, "storage"),
    MCP_CATALOG_PATH: join(home, "catalog.json"),
    MCP_AUTO_OPEN_ENABLED: "false",
  };
}

function argsForTransport(request: InspectorRequest): string[] {
  const args = [
    "--protocol-era",
    request.protocolEra,
    "--method",
    request.method,
    ...(request.flags ?? []),
  ];
  if (request.transport === "http") {
    if (request.endpoint === undefined) {
      return failure("The HTTP server endpoint is unavailable.");
    }
    return [...args, "--format", "json", "--transport", "http", "--server-url", request.endpoint];
  }
  return [
    process.execPath,
    harness,
    "serve",
    "--stdio",
    "--",
    ...args,
    "--format",
    "json",
    "--cwd",
    root,
  ];
}

async function invoke(request: InspectorRequest): Promise<ProcessResult> {
  const result = await runProcess(argsForTransport(request), request.env);
  if (result.status !== 0) {
    inspectorError(
      result,
      `${request.transport} ${request.protocolEra} ${request.method} exited ${String(result.status)}`,
    );
  }
  return result;
}

function assertProtocol(result: ProcessResult, era: "modern" | "legacy"): void {
  const envelope = jsonObject(result.stdout, "initialize");
  const response = record(envelope.result, "initialize result");
  const serverInfo = record(response.serverInfo, "server info");
  if (
    serverInfo.name !== "rovinos-ai-harness-control-plane" ||
    serverInfo.version !== "0.0.0" ||
    response.protocolVersion !== protocolVersions[era]
  ) {
    failure(`The ${era} initialize response did not match the expected server and protocol.`);
  }
}

function toolRows(result: ProcessResult): Record<string, unknown>[] {
  return result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => jsonObject(line, "tools/list --app-info"));
}

function appToolRow(
  rows: readonly Record<string, unknown>[],
  name: string,
): Record<string, unknown> | undefined {
  return rows.find((row) => row.toolName === name || row.name === name);
}

function hasPermission(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === "") {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some(hasPermission);
  }
  if (typeof value === "object") {
    return Object.values(value).some(hasPermission);
  }
  return true;
}

function assertAppVisibility(rows: readonly Record<string, unknown>[], advertised: boolean): void {
  for (const name of appTools) {
    const row = appToolRow(rows, name);
    if (!advertised) {
      if (row?.hasApp === true) {
        failure(`App-only tool ${name} was reported as visible without Apps support.`);
      }
      continue;
    }
    if (row?.hasApp !== true || row.resourceUri !== "ui://harness/approval/v1") {
      const observed =
        row === undefined
          ? rows.map((entry) => entry.toolName ?? entry.name)
          : { hasApp: row.hasApp, resourceUri: row.resourceUri };
      failure(
        `App-only tool ${name} did not advertise the approval app: ${JSON.stringify(observed)}.`,
      );
    }
    if (hasPermission(row.csp) || hasPermission(row.permissions)) {
      failure(`Approval app ${name} declared CSP domains or extra permissions.`);
    }
  }
}

async function checkTransport(
  transport: "stdio" | "http",
  endpoint: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const request = { transport, endpoint, env };
  for (const era of ["modern", "legacy"] as const) {
    assertProtocol(await invoke({ ...request, protocolEra: era, method: "initialize" }), era);
  }
  const list = (flags: readonly string[]) =>
    invoke({ ...request, protocolEra: "modern", method: "tools/list", flags });
  assertAppVisibility(toolRows(await list(["--app-info"])), false);
  // The Inspector rejects --strict with --app-info, so gate the full Apps-advertised list separately.
  await list(["--strict", "--advertise-apps"]);
  assertAppVisibility(toolRows(await list(["--app-info", "--advertise-apps"])), true);
  const resource = jsonObject(
    (
      await invoke({
        ...request,
        protocolEra: "modern",
        method: "resources/read",
        flags: ["--uri", "ui://harness/approval/v1"],
      })
    ).stdout,
    "approval resources/read",
  );
  const contents = record(resource.result, "resources/read result").contents;
  if (!Array.isArray(contents)) {
    failure("The approval resource did not return content.");
  }
  const html = contents
    .map((entry) => record(entry, "approval resource content"))
    .find((entry) => entry.mimeType === "text/html;profile=mcp-app");
  if (html === undefined || typeof html.text !== "string" || !html.text.includes("<html")) {
    failure("The approval resource did not return the built MCP Apps HTML.");
  }
}

async function startHttpServer(env: NodeJS.ProcessEnv): Promise<RunningServer> {
  const child = spawn(process.execPath, [harness, "serve", "--http", "--port", "0"], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const endpoint = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("harness serve --http timed out."));
    }, 30_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const match = /http:\/\/127\.0\.0\.1:\d+\/mcp/u.exec(stdout);
      if (match?.[0] !== undefined) {
        clearTimeout(timeout);
        resolve(match[0]);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", (error: Error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (status) => {
      clearTimeout(timeout);
      reject(new Error(`harness serve --http exited ${String(status)}: ${stderr}`));
    });
  });
  return {
    child,
    endpoint,
    close: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        const timeout = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 5_000);
        child.once("close", () => {
          clearTimeout(timeout);
          resolve();
        });
        child.kill("SIGTERM");
      }),
  };
}

function fixtureSource(): string {
  return [
    'import { McpServer } from "@modelcontextprotocol/server";',
    'import { serveStdio } from "@modelcontextprotocol/server/stdio";',
    'const server = new McpServer({ name: "nonportable-fixture", version: "1.0.0" });',
    "server.server.registerCapabilities({ tools: {} });",
    'server.server.setRequestHandler("tools/list", () => ({ tools: [{ name: "invalid_schema", description: "fixture", inputSchema: { type: "object", properties: { value: true } } }] }));',
    "serveStdio(() => server);",
  ].join("\n");
}

async function checkStrictNegative(env: NodeJS.ProcessEnv): Promise<void> {
  const result = await runProcess(
    [
      process.execPath,
      "--input-type=module",
      "-e",
      fixtureSource(),
      "--",
      "--cwd",
      root,
      "--protocol-era",
      "modern",
      "--method",
      "tools/list",
      "--strict",
    ],
    env,
  );
  if (
    result.status !== 6 ||
    !result.stderr.includes("schema_unportable") ||
    !result.stderr.includes('"error"')
  ) {
    inspectorError(result, "The non-portable schema fixture did not fail with exit code 6");
  }
}

async function seedSyntheticRun(dataDir: string): Promise<void> {
  const store = new SqliteEventStore(join(dataDir, "harness.db"));
  try {
    const runId = Id.parse("00000000000000000000000001");
    const event: NewEvent = {
      runId,
      ts: 1,
      v: 1,
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      segmentId: runId,
      type: "run_created",
      configHash: "c".repeat(64),
      policyVersion: "policy.v1",
      depth: 0,
    };
    await store.append(runId, [event], 0);
  } finally {
    await store.close();
  }
}

/** Runs the MCP Inspector conformance gate against both harness server transports. */
export async function runInspectorConformance(): Promise<void> {
  const workDir = await mkdtemp(join(tmpdir(), "harness-inspector-conformance-"));
  const home = join(workDir, "home");
  const dataDir = join(workDir, "data");
  const configPath = join(workDir, "harness.config.json");
  let httpServer: RunningServer | undefined;
  try {
    await Promise.all([mkdir(home), mkdir(dataDir)]);
    await writeFile(configPath, "{}\n", { mode: 0o600 });
    await seedSyntheticRun(dataDir);
    const env = minimalEnvironment(home, configPath, dataDir);
    await checkTransport("stdio", undefined, env);
    httpServer = await startHttpServer(env);
    await checkTransport("http", httpServer.endpoint, env);
    await checkStrictNegative(env);
  } finally {
    await httpServer?.close();
    await rm(workDir, { recursive: true, force: true });
  }
}

if (
  process.argv[1] !== undefined &&
  resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runInspectorConformance()
    .then(() => process.stdout.write("MCP Inspector conformance passed.\n"))
    .catch((error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : "inspector_conformance_failed"}\n`,
      );
      process.exitCode = 1;
    });
}
