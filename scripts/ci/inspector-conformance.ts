// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process";
import { join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJson } from "@rovinos/schemas";
import { z } from "zod";
import {
  INSPECTOR_HTTP_TOKEN,
  INSPECTOR_READ_TOKEN,
  startInspectorFixture,
} from "./inspector-http.js";

const root = resolvePath(import.meta.dirname, "../..");
const harness = resolvePath(root, "packages/cli/dist/bin.js");
const inspector = resolvePath(
  root,
  "node_modules/@modelcontextprotocol/inspector/clients/launcher/build/index.js",
);
const objectSchema = z.record(z.string(), z.unknown());
const protocolVersions = { modern: "2026-07-28", legacy: "2025-11-25" } as const;
const appOnlyTools = [
  "approve",
  "deny",
  "answer_input",
  "harness.approvals.get",
  "harness.approvals.resolve",
  "harness.approvals.reveal",
  "harness.inputs.answer",
  "harness.runs.list",
  "harness.runs.get",
] as const;
const appMetadataTools = [
  { name: "harness.approvals.get", resourceUri: "ui://harness/approval/v1" },
  { name: "harness.approvals.resolve", resourceUri: "ui://harness/approval/v1" },
  { name: "harness.approvals.reveal", resourceUri: "ui://harness/approval/v1" },
  { name: "harness.inputs.answer", resourceUri: "ui://harness/input/v1" },
  { name: "harness.runs.list", resourceUri: "ui://harness/runs/v1" },
  { name: "harness.runs.get", resourceUri: "ui://harness/runs/v1" },
] as const;

interface ProcessResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
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

function assertNoCredentialCanary(result: ProcessResult, label: string): void {
  const output = `${result.stdout}${result.stderr}`;
  if ([INSPECTOR_HTTP_TOKEN, INSPECTOR_READ_TOKEN].some((token) => output.includes(token))) {
    failure(`${label} exposed an HTTP bearer-token canary.`);
  }
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
  assertNoCredentialCanary(result, "The Inspector");
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

function toolResponse(result: ProcessResult, label: string): Record<string, unknown> {
  return record(jsonObject(result.stdout, label).result, `${label} result`);
}

function assertSuccessfulToolCall(result: ProcessResult, label: string): string[] {
  const response = toolResponse(result, label);
  if (response.isError === true) {
    failure(`${label} returned an MCP tool error.`);
  }
  const structured = record(response.structuredContent, `${label} structured content`);
  if (!Array.isArray(structured.runs)) {
    failure(`${label} did not return the run list.`);
  }
  return structured.runs.map((run) => {
    const row = record(run, `${label} run`);
    if (typeof row.runId !== "string") {
      return failure(`${label} returned a run without an identifier.`);
    }
    return row.runId;
  });
}

function assertToolError(result: ProcessResult, label: string, code: string): void {
  assertNoCredentialCanary(result, label);
  if (result.status !== 5) {
    failure(`${label} did not use Inspector exit status 5 for an MCP tool error.`);
  }
  const found = outputEnvelopes(result).some((envelope) => {
    const error = objectSchema.safeParse(envelope.error);
    if (error.success && error.data.code === code) {
      return true;
    }
    const response = objectSchema.safeParse(envelope.result);
    if (!response.success || response.data.isError !== true) {
      return false;
    }
    const structured = objectSchema.safeParse(response.data.structuredContent);
    if (structured.success && structured.data.code === code) {
      return true;
    }
    return (
      Array.isArray(response.data.content) &&
      response.data.content.some((item) => {
        const content = objectSchema.safeParse(item);
        return (
          content.success &&
          content.data.type === "text" &&
          typeof content.data.text === "string" &&
          content.data.text.includes(code)
        );
      })
    );
  });
  if (!found) {
    failure(`${label} did not return the expected MCP tool-error code.`);
  }
}

function outputEnvelopes(result: ProcessResult): Record<string, unknown>[] {
  return [result.stdout, result.stderr]
    .flatMap((text) => [text, ...text.split("\n").reverse()])
    .flatMap((candidate) => {
      try {
        return [parseJson(objectSchema, candidate.trim())];
      } catch {
        return [];
      }
    });
}

function assertCallFailure(result: ProcessResult, label: string): void {
  assertNoCredentialCanary(result, label);
  if (result.status === 0) {
    failure(`${label} unexpectedly exited successfully.`);
  }
  const hasErrorEnvelope = outputEnvelopes(result).some((envelope) => {
    const toolResult = objectSchema.safeParse(envelope.result);
    if (toolResult.success && toolResult.data.isError === true) {
      return Array.isArray(toolResult.data.content);
    }
    const error = objectSchema.safeParse(envelope.error);
    return (
      error.success &&
      (typeof error.data.code === "string" || typeof error.data.code === "number") &&
      typeof error.data.message === "string"
    );
  });
  if (!hasErrorEnvelope) {
    failure(`${label} did not return a protocol or tool error response.`);
  }
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
  for (const name of appOnlyTools) {
    const row = appToolRow(rows, name);
    if (!advertised && row !== undefined) {
      failure(`App-only tool ${name} was listed without Apps support.`);
    }
    if (advertised && row === undefined) {
      failure(`App-only tool ${name} was not listed with Apps support.`);
    }
  }
  if (!advertised) {
    return;
  }
  for (const appTool of appMetadataTools) {
    const row = appToolRow(rows, appTool.name);
    if (row?.hasApp !== true || row.resourceUri !== appTool.resourceUri) {
      const observed =
        row === undefined
          ? rows.map((entry) => entry.toolName ?? entry.name)
          : { hasApp: row.hasApp, resourceUri: row.resourceUri };
      failure(
        `App-only tool ${appTool.name} did not advertise its MCP App: ${JSON.stringify(observed)}.`,
      );
    }
    if (hasPermission(row.csp) || hasPermission(row.permissions)) {
      failure(`MCP App for ${appTool.name} declared CSP domains or extra permissions.`);
    }
  }
}

async function checkTransport(
  transport: "stdio" | "http",
  endpoint: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const flags =
    transport === "http"
      ? [
          "--header",
          ["Authorization:", ["Be", "arer ", INSPECTOR_HTTP_TOKEN].join("")].join(" "),
          "--stored-auth-only",
        ]
      : [];
  const request = { transport, endpoint, env, flags };
  const invokeWithFlags = (extraFlags: readonly string[]) =>
    invoke({
      ...request,
      protocolEra: "modern",
      method: "tools/list",
      flags: [...flags, ...extraFlags],
    });
  for (const era of ["modern", "legacy"] as const) {
    assertProtocol(await invoke({ ...request, protocolEra: era, method: "initialize" }), era);
  }
  assertAppVisibility(toolRows(await invokeWithFlags(["--app-info"])), false);
  // The Inspector rejects --strict with --app-info, so gate the full Apps-advertised list separately.
  await invokeWithFlags(["--strict", "--advertise-apps"]);
  assertAppVisibility(toolRows(await invokeWithFlags(["--app-info", "--advertise-apps"])), true);
  await checkToolCalls(transport, endpoint, env, flags);
  const resource = jsonObject(
    (
      await invoke({
        transport,
        endpoint,
        env,
        protocolEra: "modern",
        method: "resources/read",
        flags: [...flags, "--uri", "ui://harness/approval/v1"],
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

async function checkToolCalls(
  transport: "stdio" | "http",
  endpoint: string | undefined,
  env: NodeJS.ProcessEnv,
  flags: readonly string[],
): Promise<void> {
  const call = (toolName: string, toolArgs: string) =>
    runProcess(
      argsForTransport({
        transport,
        endpoint,
        env,
        protocolEra: "modern",
        method: "tools/call",
        flags: [...flags, "--tool-name", toolName, "--tool-args-json", toolArgs],
      }),
      env,
    );
  const success = await invoke({
    transport,
    endpoint,
    env,
    protocolEra: "modern",
    method: "tools/call",
    flags: [...flags, "--tool-name", "list_runs", "--tool-args-json", "{}"],
  });
  assertSuccessfulToolCall(success, `${transport} list_runs`);

  const malformed = await call("list_runs", '{"limit":0}');
  assertCallFailure(malformed, `${transport} malformed arguments`);

  const unknown = await call("harness.unknown.synthetic", "{}");
  assertToolError(unknown, `${transport} unknown tool`, "tool_not_found");
}

async function checkUnauthenticatedHttp(endpoint: string, env: NodeJS.ProcessEnv): Promise<void> {
  const result = await runProcess(
    argsForTransport({
      transport: "http",
      endpoint,
      env,
      protocolEra: "modern",
      method: "initialize",
      flags: ["--stored-auth-only"],
    }),
    env,
  );
  const output = `${result.stdout}${result.stderr}`;
  assertNoCredentialCanary(result, "The unauthenticated Inspector attempt");
  if (result.status !== 3 || !output.includes("auth_required")) {
    failure("Unauthenticated Inspector initialization did not exit 3 with auth_required.");
  }
}

async function checkRestrictedHttp(endpoint: string, env: NodeJS.ProcessEnv): Promise<void> {
  const flags = [
    "--header",
    ["Authorization:", ["Be", "arer ", INSPECTOR_READ_TOKEN].join("")].join(" "),
    "--stored-auth-only",
  ];
  const call = (name: string, args: string) =>
    runProcess(
      argsForTransport({
        transport: "http",
        endpoint,
        env,
        protocolEra: "modern",
        method: "tools/call",
        flags: [...flags, "--tool-name", name, "--tool-args-json", args],
      }),
      env,
    );

  const before = await invoke({
    transport: "http",
    endpoint,
    env,
    protocolEra: "modern",
    method: "tools/call",
    flags: [...flags, "--tool-name", "list_runs", "--tool-args-json", "{}"],
  });
  const beforeRunIds = assertSuccessfulToolCall(before, "restricted list_runs");

  const guessedAppTool = await call(
    "harness.approvals.get",
    '{"approvalId":"00000000000000000000000001"}',
  );
  assertToolError(
    guessedAppTool,
    "restricted guessed App tool",
    "control_plane_scope_required",
  );
  const deniedMutation = await call("start_run", '{"goal":"synthetic denied run"}');
  assertToolError(deniedMutation, "restricted start_run", "control_plane_scope_required");

  const after = await invoke({
    transport: "http",
    endpoint,
    env,
    protocolEra: "modern",
    method: "tools/call",
    flags: [...flags, "--tool-name", "list_runs", "--tool-args-json", "{}"],
  });
  const afterRunIds = assertSuccessfulToolCall(after, "restricted list_runs after denial");
  if (JSON.stringify(beforeRunIds) !== JSON.stringify(afterRunIds)) {
    failure("A forbidden operation changed the restricted run list.");
  }
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

/** Runs the MCP Inspector conformance gate against both harness server transports. */
export async function runInspectorConformance(): Promise<void> {
  const fixture = await startInspectorFixture({ root, harness });
  try {
    await checkTransport("stdio", undefined, fixture.env);
    await checkUnauthenticatedHttp(fixture.endpoint, fixture.env);
    await checkTransport("http", fixture.endpoint, fixture.env);
    await checkRestrictedHttp(fixture.endpoint, fixture.env);
    await checkStrictNegative(fixture.env);
  } finally {
    await fixture.close();
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
