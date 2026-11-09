// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJson } from "@rovinos/schemas";
import { z } from "zod";
import {
  checkRestrictedHttp,
  checkStrictNegative,
  checkToolCalls,
  type InspectorRequest,
  type ProcessResult,
} from "./inspector-tool-calls.ts";
import {
  INSPECTOR_HTTP_TOKEN,
  INSPECTOR_READ_TOKEN,
  startInspectorFixture,
} from "./inspector-http.ts";

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
  await checkToolCalls({
    transport,
    endpoint,
    env,
    flags,
    invoke,
    runProcess,
    argsForTransport,
  });
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

/** Runs the MCP Inspector conformance gate against both harness server transports. */
export async function runInspectorConformance(): Promise<void> {
  const fixture = await startInspectorFixture({ root, harness });
  try {
    await checkTransport("stdio", undefined, fixture.env);
    await checkUnauthenticatedHttp(fixture.endpoint, fixture.env);
    await checkTransport("http", fixture.endpoint, fixture.env);
    await checkRestrictedHttp({
      endpoint: fixture.endpoint,
      env: fixture.env,
      invoke,
      runProcess,
      argsForTransport,
    });
    await checkStrictNegative(fixture.env, root, runProcess);
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
