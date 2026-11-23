// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process";
import { resolve as resolvePath } from "node:path";
import { parseJson } from "@rovinos/schemas";
import { z } from "zod";
import {
  readApprovalResolutions,
  type PendingApproval,
  type SessionFixture,
} from "./inspector-sessions-fixture.ts";

const root = resolvePath(import.meta.dirname, "../..");
const harness = resolvePath(root, "packages/cli/dist/bin.js");
const mcpdo = resolvePath(
  root,
  "node_modules/@modelcontextprotocol/inspector/clients/mcpdo/build/mcp-bin.js",
);
const requestTimeoutMs = 20_000;
const objectSchema = z.record(z.string(), z.unknown());

interface CommandResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function failure(message: string): never {
  throw new Error(
    `${message}\n${JSON.stringify({ error: { code: "inspector_sessions_failed" } })}`,
  );
}

function record(value: unknown, label: string): Record<string, unknown> {
  const parsed = objectSchema.safeParse(value);
  return parsed.success ? parsed.data : failure(`${label} was not a JSON object.`);
}

function parseOutput(text: string, label: string): Record<string, unknown> {
  try {
    return parseJson(objectSchema, text.trim());
  } catch {
    return failure(`${label} did not return JSON.`);
  }
}

function runCommand(
  args: readonly string[],
  env: Record<string, string>,
  signal: AbortSignal | undefined,
  timeoutMs = requestTimeoutMs,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [mcpdo, ...args], {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    const abort = () => {
      child.kill("SIGTERM");
    };
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", (error: Error) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("close", (status) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      if (timedOut) {
        reject(new Error("mcpdo command exceeded its bounded timeout."));
      } else if (signal?.aborted === true) {
        reject(new Error("Inspector session was cancelled."));
      } else {
        resolve({ status: status ?? -1, stdout, stderr });
      }
    });
  });
}

async function mcpdoCommand(
  args: readonly string[],
  env: Record<string, string>,
  signal: AbortSignal | undefined,
  label: string,
): Promise<Record<string, unknown>> {
  const result = await runCommand(args, env, signal);
  if (result.status !== 0) {
    failure(`${label} exited with status ${String(result.status)}.`);
  }
  return parseOutput(result.stdout, label);
}

function connectionArgs(connection: string): string[] {
  return ["--format", "json", "--connection", connection];
}

/** Opens a persistent Inspector client session to the synthetic harness server. */
export async function connectMcpdoSession(
  fixture: SessionFixture,
  connection: string,
  signal: AbortSignal,
): Promise<void> {
  const output = await mcpdoCommand(
    [
      ...connectionArgs(connection),
      "connect",
      "--transport",
      "stdio",
      "--era",
      "modern",
      "--elicit",
      "form",
      "--connect-timeout",
      String(requestTimeoutMs),
      "--cwd",
      root,
      "-e",
      `HARNESS_CONFIG=${fixture.configPath}`,
      "-e",
      `HARNESS_DATA_DIR=${fixture.dataDir}`,
      "-e",
      `HOME=${fixture.home}`,
      "-e",
      `USERPROFILE=${fixture.home}`,
      "-e",
      `PATH=${fixture.env.PATH ?? ""}`,
      "--",
      process.execPath,
      harness,
      "serve",
      "--stdio",
    ],
    fixture.env,
    signal,
    "mcpdo connect",
  );
  if (output.pendingAuth === true) {
    failure("The synthetic stdio session unexpectedly requested authentication.");
  }
}

async function callDecisionTool(
  fixture: SessionFixture,
  connection: string,
  approval: PendingApproval,
  signal: AbortSignal,
): Promise<string> {
  const output = await mcpdoCommand(
    [
      ...connectionArgs(connection),
      "tools/call",
      "--tool-name",
      "review_approval",
      "--tool-args-json",
      JSON.stringify({ approvalId: approval.approvalId }),
    ],
    fixture.env,
    signal,
    "mcpdo tools/call",
  );
  const pending = record(output.elicitationPending, "mcpdo elicitation");
  if (typeof pending.elicitationId !== "string") {
    return failure("mcpdo did not return an elicitation identifier.");
  }
  return pending.elicitationId;
}

function toolResult(value: unknown, label: string): Record<string, unknown> {
  const outer = record(value, label);
  return record(outer.result ?? outer, label);
}

/** Checks a decision response and its human-readable confirmation when approved. */
export function assertResolved(value: unknown, expected: boolean, label: string): void {
  const result = toolResult(value, label);
  const structured = record(result.structuredContent, label);
  if (structured.resolved !== expected || result.isError === true) {
    failure(`${label} did not return the expected resolved=${String(expected)} result.`);
  }
  const text = Array.isArray(result.content)
    ? result.content
        .map((item) => objectSchema.safeParse(item))
        .filter((item) => item.success)
        .map((item) => item.data.text)
        .filter((item): item is string => typeof item === "string")
        .join("\n")
    : "";
  if (expected && !text.includes("Decision recorded.")) {
    failure(`${label} did not confirm that the human decision was recorded.`);
  }
}

interface ElicitationResponse {
  readonly fixture: SessionFixture;
  readonly connection: string;
  readonly elicitationId: string;
  readonly answer: readonly string[];
  readonly label: string;
  readonly signal: AbortSignal;
}

async function respondToElicitation(input: ElicitationResponse): Promise<Record<string, unknown>> {
  return mcpdoCommand(
    [
      ...connectionArgs(input.connection),
      "elicitation/respond",
      input.elicitationId,
      ...input.answer,
    ],
    input.fixture.env,
    input.signal,
    input.label,
  );
}

/** Confirms the approval and checks its single durable decision event. */
export async function runConfirmedMcpdoFlow(
  fixture: SessionFixture,
  connection: string,
  signal: AbortSignal,
): Promise<void> {
  const elicitationId = await callDecisionTool(
    fixture,
    connection,
    fixture.approvals.confirmed,
    signal,
  );
  const response = await respondToElicitation({
    fixture,
    connection,
    elicitationId,
    answer: ["decision:=approve"],
    label: "mcpdo confirmed elicitation",
    signal,
  });
  assertResolved(response, true, "confirmed mcpdo decision");
  const resolutions = await readApprovalResolutions(fixture.dbPath, fixture.approvals.confirmed);
  if (resolutions.count !== 1 || resolutions.decisions[0] !== "approve") {
    failure("The confirmed mcpdo decision was not recorded exactly once.");
  }
}

/** Declines the approval and verifies that no decision event was recorded. */
export async function runDeclinedMcpdoFlow(
  fixture: SessionFixture,
  connection: string,
  signal: AbortSignal,
): Promise<void> {
  const elicitationId = await callDecisionTool(
    fixture,
    connection,
    fixture.approvals.declined,
    signal,
  );
  const response = await respondToElicitation({
    fixture,
    connection,
    elicitationId,
    answer: ["--decline"],
    label: "mcpdo declined elicitation",
    signal,
  });
  assertResolved(response, false, "declined mcpdo decision");
  const resolutions = await readApprovalResolutions(fixture.dbPath, fixture.approvals.declined);
  if (resolutions.count !== 0) {
    failure("Declining the mcpdo elicitation recorded an approval decision.");
  }
}

/** Closes the persistent Inspector connection. */
export async function disconnectMcpdoSession(
  fixture: SessionFixture,
  connection: string,
): Promise<void> {
  const output = await mcpdoCommand(
    [...connectionArgs(connection), "disconnect"],
    fixture.env,
    undefined,
    "mcpdo disconnect",
  );
  if (output.name === undefined) {
    failure("mcpdo did not confirm that its session disconnected.");
  }
}

/** Stops the Inspector daemon, failing when it cannot be confirmed stopped. */
export async function stopMcpdoDaemon(env: Record<string, string>): Promise<void> {
  const result = await runCommand(
    ["--format", "json", "daemon", "stop"],
    env,
    undefined,
    10_000,
  ).catch(() => undefined);
  if (result?.status !== 0) {
    failure("mcpdo daemon stop failed.");
  }
}
