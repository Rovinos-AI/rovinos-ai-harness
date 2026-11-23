// SPDX-License-Identifier: Apache-2.0
import { resolve } from "node:path";
import { Client, isInputRequiredResult, withInputRequired } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { z } from "zod";
import { assertResolved } from "./inspector-sessions-client.ts";
import {
  readApprovalResolutions,
  type PendingApproval,
  type SessionFixture,
} from "./inspector-sessions-fixture.ts";

const root = resolve(import.meta.dirname, "../..");
const harness = resolve(root, "packages/cli/dist/bin.js");
const requestTimeoutMs = 20_000;
const objectSchema = z.record(z.string(), z.unknown());
const toolResultSchema = z.looseObject({});

function failure(message: string): never {
  throw new Error(`${message}\n${JSON.stringify({ error: { code: "inspector_sessions_failed" } })}`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  const parsed = objectSchema.safeParse(value);
  return parsed.success ? parsed.data : failure(`${label} was not a JSON object.`);
}

function requestParams(approval: PendingApproval): ReturnType<typeof makeRequestParams> {
  return makeRequestParams(approval);
}

function makeRequestParams(approval: PendingApproval) {
  return {
    name: "review_approval",
    arguments: { approvalId: approval.approvalId },
  };
}

async function manualToolCall(
  client: Client,
  params: ReturnType<typeof makeRequestParams> & Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  return client.request(
    { method: "tools/call", params },
    withInputRequired(toolResultSchema),
    { allowInputRequired: true, maxTotalTimeout: requestTimeoutMs, signal },
  );
}

function stateFromInputRequired(value: unknown): string {
  const inputRequired = record(value, "input-required result");
  if (typeof inputRequired.requestState !== "string") {
    return failure("The elicitation response did not include confirmation request state.");
  }
  const inputRequests = record(inputRequired.inputRequests, "input requests");
  if (inputRequests.decision === undefined) {
    return failure("The replay fixture did not request a decision.");
  }
  return inputRequired.requestState;
}

function toolResult(value: unknown): Record<string, unknown> {
  const result = record(value, "replayed confirmation state");
  return record(result.result ?? result, "replayed confirmation state");
}

function assertReplay(value: unknown): void {
  const result = toolResult(value);
  const structured = record(result.structuredContent, "replayed confirmation result");
  const content = Array.isArray(result.content)
    ? result.content
        .map((item) => objectSchema.safeParse(item))
        .filter((item) => item.success)
        .map((item) => item.data.text)
        .filter((item): item is string => typeof item === "string")
        .join("\n")
    : "";
  if (
    result.isError !== true ||
    structured.resolved !== false ||
    !content.includes("confirmation_state_replayed")
  ) {
    failure("Reusing confirmation state did not return confirmation_state_replayed.");
  }
}

/** Exercises single-use confirmation state through manual input-required requests. */
export async function runReplayFlow(
  fixture: SessionFixture,
  signal: AbortSignal,
): Promise<void> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [harness, "serve", "--stdio"],
    cwd: root,
    env: fixture.env,
  });
  const client = new Client(
    { name: "rovinos-inspector-replay-test", version: "1.0.0" },
    {
      capabilities: { elicitation: { form: {} } },
      versionNegotiation: { mode: "auto" },
      inputRequired: { autoFulfill: false },
    },
  );
  try {
    await client.connect(transport);
    const params = requestParams(fixture.approvals.replay);
    const initial = await manualToolCall(client, params, signal);
    if (!isInputRequiredResult(initial)) {
      failure("The replay fixture did not request elicitation.");
    }
    const requestState = stateFromInputRequired(initial);
    const retryParams = {
      ...params,
      requestState,
      inputResponses: { decision: { action: "decline" } },
    };
    const declined = await manualToolCall(client, retryParams, signal);
    if (isInputRequiredResult(declined)) {
      failure("The consumed confirmation state requested unexpected additional input.");
    }
    assertResolved(declined, false, "first replay-state response");
    const replayed = await manualToolCall(client, retryParams, signal);
    if (isInputRequiredResult(replayed)) {
      failure("The replayed confirmation state unexpectedly requested more input.");
    }
    assertReplay(replayed);
    const resolutions = await readApprovalResolutions(fixture.dbPath, fixture.approvals.replay);
    if (resolutions.count !== 0) {
      failure("Replaying confirmation state recorded an approval decision.");
    }
  } finally {
    await client.close();
  }
}
