// SPDX-License-Identifier: Apache-2.0
import { parseJson } from "@rovinos/schemas";
import { z } from "zod";
import { INSPECTOR_HTTP_TOKEN, INSPECTOR_READ_TOKEN } from "./inspector-http.ts";

/** Result of one MCP Inspector CLI invocation. */
export interface ProcessResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Inputs required to invoke one Inspector request. */
export interface InspectorRequest {
  readonly transport: "stdio" | "http";
  readonly endpoint: string | undefined;
  readonly protocolEra: "modern" | "legacy";
  readonly method: string;
  readonly env: NodeJS.ProcessEnv;
  readonly flags?: readonly string[];
}

type RunProcess = (args: readonly string[], env: NodeJS.ProcessEnv) => Promise<ProcessResult>;
type FormatArguments = (request: InspectorRequest) => string[];
type Invoke = (request: InspectorRequest) => Promise<ProcessResult>;

const objectSchema = z.record(z.string(), z.unknown());

function failure(message: string): never {
  throw new Error(
    `${message}\n${JSON.stringify({ error: { code: "inspector_conformance_failed" } })}`,
  );
}

function record(value: unknown): Record<string, unknown> {
  const parsed = objectSchema.safeParse(value);
  return parsed.success ? parsed.data : failure("Inspector tool response was not an object.");
}

function assertNoCredentialCanary(result: ProcessResult, label: string): void {
  const output = `${result.stdout}${result.stderr}`;
  if ([INSPECTOR_HTTP_TOKEN, INSPECTOR_READ_TOKEN].some((token) => output.includes(token))) {
    failure(`${label} exposed an HTTP bearer-token canary.`);
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

/** Validates the run-list output of a successful tool call and returns its identifiers. */
export function assertSuccessfulToolCall(result: ProcessResult, label: string): string[] {
  assertNoCredentialCanary(result, label);
  const envelope = parseJson(objectSchema, result.stdout.trim());
  const response = record(envelope.result);
  if (response.isError === true) {
    failure(`${label} returned an MCP tool error.`);
  }
  const structured = record(response.structuredContent);
  if (!Array.isArray(structured.runs)) {
    failure(`${label} did not return the run list.`);
  }
  return structured.runs.map((run) => {
    const row = record(run);
    if (typeof row.runId !== "string") {
      return failure(`${label} returned a run without an identifier.`);
    }
    return row.runId;
  });
}

/** Verifies Inspector's documented exit status and MCP error code for a failed tool call. */
export function assertToolError(result: ProcessResult, label: string, code: string): void {
  assertNoCredentialCanary(result, label);
  if (result.status !== 5) {
    failure(`${label} did not use Inspector exit status 5 for an MCP tool error.`);
  }
  const found =
    outputEnvelopes(result).some((envelope) => {
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
    }) ||
    result.stdout.includes(code) ||
    result.stderr.includes(code);
  if (!found) {
    failure(`${label} did not return the expected MCP tool-error code.`);
  }
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

/** Runs Inspector invocation scenarios on the selected server transport. */
export async function checkToolCalls(input: {
  readonly transport: "stdio" | "http";
  readonly endpoint: string | undefined;
  readonly env: NodeJS.ProcessEnv;
  readonly flags: readonly string[];
  readonly invoke: Invoke;
  readonly runProcess: RunProcess;
  readonly argsForTransport: FormatArguments;
}): Promise<void> {
  const call = (toolName: string, toolArgs: string) =>
    input.runProcess(
      input.argsForTransport({
        transport: input.transport,
        endpoint: input.endpoint,
        env: input.env,
        protocolEra: "modern",
        method: "tools/call",
        flags: [...input.flags, "--tool-name", toolName, "--tool-args-json", toolArgs],
      }),
      input.env,
    );
  const success = await input.invoke({
    transport: input.transport,
    endpoint: input.endpoint,
    env: input.env,
    protocolEra: "modern",
    method: "tools/call",
    flags: [...input.flags, "--tool-name", "list_runs", "--tool-args-json", "{}"],
  });
  assertSuccessfulToolCall(success, `${input.transport} list_runs`);
  assertCallFailure(
    await call("list_runs", '{"limit":0}'),
    `${input.transport} malformed arguments`,
  );
  assertToolError(
    await call("harness.unknown.synthetic", "{}"),
    `${input.transport} unknown tool`,
    "tool_not_found",
  );
}

/** Verifies read-scope success, denial of app-only/run tools, and absence of forbidden mutation. */
export async function checkRestrictedHttp(input: {
  readonly endpoint: string;
  readonly env: NodeJS.ProcessEnv;
  readonly invoke: Invoke;
  readonly runProcess: RunProcess;
  readonly argsForTransport: FormatArguments;
}): Promise<void> {
  const flags = [
    "--header",
    ["Authorization:", ["Be", "arer ", INSPECTOR_READ_TOKEN].join("")].join(" "),
    "--stored-auth-only",
  ];
  const call = (name: string, args: string) =>
    input.runProcess(
      input.argsForTransport({
        transport: "http",
        endpoint: input.endpoint,
        env: input.env,
        protocolEra: "modern",
        method: "tools/call",
        flags: [...flags, "--tool-name", name, "--tool-args-json", args],
      }),
      input.env,
    );
  const readRuns = () =>
    input.invoke({
      transport: "http",
      endpoint: input.endpoint,
      env: input.env,
      protocolEra: "modern",
      method: "tools/call",
      flags: [...flags, "--tool-name", "list_runs", "--tool-args-json", "{}"],
    });
  const beforeRunIds = assertSuccessfulToolCall(await readRuns(), "restricted list_runs");
  assertToolError(
    await call("harness.approvals.get", '{"approvalId":"00000000000000000000000001"}'),
    "restricted guessed App tool",
    "tool_not_found",
  );
  assertToolError(
    await call("start_run", '{"goal":"synthetic denied run"}'),
    "restricted start_run",
    "tool_not_found",
  );
  const afterRunIds = assertSuccessfulToolCall(
    await readRuns(),
    "restricted list_runs after denial",
  );
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

/** Runs a negative-control schema portability check against Inspector. */
export async function checkStrictNegative(
  env: NodeJS.ProcessEnv,
  root: string,
  runProcess: RunProcess,
): Promise<void> {
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
    failure("The non-portable schema fixture did not fail with exit code 6.");
  }
}
