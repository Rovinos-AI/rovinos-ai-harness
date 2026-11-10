// SPDX-License-Identifier: Apache-2.0
import { fileURLToPath } from "node:url";
import { resolve as resolvePath } from "node:path";
import { Code, ServerConfigSchema } from "@rovinos/schemas";
import { McpToolPort } from "@rovinos/mcp";
import { z } from "zod";

const scenarioSchema = z.literal("tools_call");
const protocolSchema = z.literal("2026-07-28");
const loopbackUrlSchema = z.url().superRefine((value, context) => {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    context.addIssue({ code: "custom", message: "Conformance server must be loopback HTTP." });
  }
});

function failure(code: string): never {
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
  throw new Error(code);
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const parsed = Code.safeParse(error.code);
    if (parsed.success) {
      return parsed.data;
    }
  }
  return "mcp_conformance_client_failed";
}

/** Runs the MCP client conformance adapter through the harness tool-port implementation. */
export async function runConformanceClient(
  scenarioValue: unknown,
  protocolValue: unknown,
  serverUrlValue: unknown,
): Promise<void> {
  scenarioSchema.parse(scenarioValue);
  const protocol = protocolSchema.parse(protocolValue);
  const serverUrl = loopbackUrlSchema.parse(serverUrlValue);
  const server = ServerConfigSchema.parse({
    id: "conformance",
    protocol,
    transport: { kind: "http", url: serverUrl },
  });
  const port = await McpToolPort.create([server], {
    resolveSecret: () => {
      throw new Error("unexpected_secret_resolution");
    },
  });
  try {
    const tool = port.getToolSpecs().find(({ toolId }) => toolId === "conformance.add_numbers");
    if (tool === undefined) {
      failure("mcp_conformance_tool_missing");
    }
    const result = await port.execute(
      {
        callId: "00000000000000000000000000",
        toolId: tool.toolId,
        args: { a: 2, b: 3 },
      },
      { signal: AbortSignal.timeout(15_000) },
    );
    if (result.outcome !== "ok") {
      failure(result.errorCode ?? "mcp_conformance_tool_call_failed");
    }
  } finally {
    await port.close();
  }
}

async function main(): Promise<void> {
  try {
    const scenario = process.env.MCP_CONFORMANCE_SCENARIO;
    const protocol = process.env.MCP_CONFORMANCE_PROTOCOL_VERSION;
    const serverUrl = process.argv.at(-1);
    await runConformanceClient(scenario, protocol, serverUrl);
    process.stdout.write('{"status":"ok"}\n');
  } catch (error) {
    if (process.exitCode !== 1) {
      process.stderr.write(`${errorCode(error)}\n`);
      process.exitCode = 1;
    }
  }
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolvePath(process.argv[1])
) {
  void main();
}
