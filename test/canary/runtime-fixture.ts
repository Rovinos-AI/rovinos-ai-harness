// SPDX-License-Identifier: Apache-2.0
import type { Runtime, RuntimeOverrides, ModelCompletion, ToolPort } from "@harness/core";
import { FakeModelPort } from "@harness/core/testing";
import { Code, Id } from "@harness/schemas";
import type { VaultValueEntry } from "@harness/schemas";
import { findTokens, tokenType } from "@harness/vault";
import type { Token } from "@harness/vault";
import { sampleFailureText } from "../fixtures/sample-mcp-failure.js";
import type { CanarySet } from "./canaries.js";

export const ECHO_TOOL = Code.parse("canary.echo");
export const FAIL_TOOL = Code.parse("canary.fail");
export const SAMPLE_MCP_FAIL_TOOL = Code.parse("sample_mcp.fail");
export const ASK_TOOL = Code.parse("canary.ask");
export const TEST_KEY_REF = "env:CANARY_TEST_KEY";

/** In-memory raw boundary data used to prove tool execution receives and throws canaries. */
export interface CanaryToolCapture {
  readonly toolBoundary: string[];
  readonly toolErrors: string[];
  readonly toolOutputs: string[];
}

/** Resolve vault values from events persisted by the production runtime. */
export class RuntimeVaultReader {
  private runtime: Runtime | undefined;
  private readonly versions = new Map<Id, number>();

  /** Attach the runtime whose store and audited resolver back this test reader. */
  attach(runtime: Runtime): void {
    this.runtime = runtime;
  }

  /** Return a monotonically increasing revision to refresh the sentinel value view. */
  version(runId: Id): Promise<number> {
    const version = (this.versions.get(runId) ?? 0) + 1;
    this.versions.set(runId, version);
    return Promise.resolve(version);
  }

  /** Resolve only tokens present in this run's persisted events. */
  async listRawValueEntries(runId: Id): Promise<readonly VaultValueEntry[]> {
    const runtime = this.runtime;
    if (runtime === undefined) {
      return [];
    }
    const tokens = new Set<Token>();
    for await (const event of runtime.store.read(runId)) {
      for (const { token } of findTokens(JSON.stringify(event))) {
        tokens.add(token);
      }
    }
    const entries: VaultValueEntry[] = [];
    for (const token of tokens) {
      const rawValue = await runtime.vault.resolve(
        runId,
        token,
        { boundary: "ui" },
        () => undefined,
      );
      if (rawValue !== undefined) {
        entries.push({ rawValue, entityType: Code.parse(tokenType(token).toLowerCase()) });
      }
    }
    return entries;
  }
}

/** Provide a fixed synthetic encryption key through the normal secret-reference boundary. */
export function createCanarySecretResolver(): NonNullable<RuntimeOverrides["secretResolver"]> {
  const value = Buffer.alloc(32, 37).toString("base64");
  return { resolve: () => Promise.resolve({ reveal: () => value }) };
}

function completion(parts: ModelCompletion["parts"]): ModelCompletion {
  return {
    provider: "synthetic",
    model: "synthetic",
    parts,
    providerBlobs: null,
    usage: { inputTokens: 1, outputTokens: 1 },
    finishReason: parts.some((part) => part.type === "tool_call") ? "tool_calls" : "stop",
    latencyMs: 0,
    schemaValid: true,
    repairAttempts: 0,
    fallbackDepth: 0,
  };
}

/** Build a raw synthetic tool port for the runtime to wrap with its PII boundary. */
export function createCanaryToolPort(
  canaries: CanarySet,
  captured: CanaryToolCapture,
  executed: string[],
): ToolPort {
  return {
    describe: (toolId) =>
      [ECHO_TOOL, FAIL_TOOL, SAMPLE_MCP_FAIL_TOOL, ASK_TOOL].includes(toolId)
        ? { idempotent: true, timeoutMs: 1_000 }
        : undefined,
    execute: (call) => {
      executed.push(call.toolId);
      captured.toolBoundary.push(JSON.stringify(call.args));
      if (call.toolId === FAIL_TOOL) {
        const error = new Error(
          `${canaries.card.value}\n${new Error(canaries.card.value).stack ?? ""}`,
        );
        captured.toolErrors.push(error.message);
        return Promise.reject(error);
      }
      if (call.toolId === SAMPLE_MCP_FAIL_TOOL) {
        const text = sampleFailureText(canaries.email.value);
        captured.toolOutputs.push(text);
        return Promise.resolve({
          outcome: "error",
          errorCode: Code.parse("tool_reported_error"),
          result: { content: [{ type: "text", text }] },
        });
      }
      if (call.toolId === ECHO_TOOL) {
        return Promise.resolve({
          outcome: "ok",
          result: { value: canaries.phone.value, repeated: canaries.phone.value },
        });
      }
      return Promise.resolve({ outcome: "ok", result: { accepted: true } });
    },
  };
}

/** Script the runtime's model port with echo, tool-output, failure, and approval inputs. */
export function createCanaryModel(canaries: CanarySet): FakeModelPort {
  const callId = (value: number): Id => Id.parse(String(value).padStart(26, "1"));
  return new FakeModelPort([
    completion([
      { type: "text", text: `Model echo: ${canaries.apiKey.value}` },
      {
        type: "tool_call",
        callId: callId(1),
        toolId: ECHO_TOOL,
        args: { value: canaries.phone.value },
      },
      {
        type: "tool_call",
        callId: callId(2),
        toolId: FAIL_TOOL,
        args: { value: canaries.card.value },
      },
      {
        type: "tool_call",
        callId: callId(3),
        toolId: SAMPLE_MCP_FAIL_TOOL,
        args: { value: canaries.email.value },
      },
      {
        type: "tool_call",
        callId: callId(4),
        toolId: ASK_TOOL,
        args: { value: canaries.person.value },
      },
    ]),
  ]);
}
