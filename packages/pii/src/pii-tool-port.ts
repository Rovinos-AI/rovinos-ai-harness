// SPDX-License-Identifier: Apache-2.0
// Preparation owns durable arguments; execution owns only the ephemeral raw copy.
import {
  ToolBinaryPayloadSchema,
  type Code,
  type Id,
  type JsonValue,
  type PiiActionSummary,
  type PiiConfig,
  type ToolSpec,
} from "@harness/schemas";
import type { AuditingVaultResolver } from "@harness/vault";
import { detokenizeArgs, PiiTokenUnresolvableError } from "./detokenize.js";
import { PiiBlockedError, PiiTokenizerError } from "./errors.js";
import type { Tokenizer } from "./tokenizer.js";

/** Schema-typed tool invocation, structurally compatible with core's port. */
export interface PiiToolCall {
  readonly callId: Id;
  readonly toolId: Code;
  readonly args: JsonValue;
}

/** Active run and optional durable summary sink. */
export interface PiiToolContext {
  readonly runId: Id;
  readonly signal: AbortSignal;
  readonly recordPiiAction?: (summary: PiiActionSummary) => Promise<void>;
}

/** JSON execution contract with a validated numeric-byte binary representation. */
export interface PiiToolResult {
  readonly binary?: boolean;
  readonly outcome: "ok" | "error";
  readonly result: JsonValue;
  readonly errorCode?: Code;
}

/** Structural port avoids a dependency from PII back to core. */
export interface PiiToolPortLike {
  describe(toolId: Code): { readonly idempotent: boolean; readonly timeoutMs: number } | undefined;
  getToolSpecs?(): readonly ToolSpec[];
  prepare?(call: PiiToolCall, context: PiiToolContext): Promise<PiiToolCall>;
  execute(call: PiiToolCall, context: PiiToolContext): Promise<PiiToolResult>;
}

/** Injected tokenizer, full allowlist configuration, and auditing resolver. */
export interface PiiToolPortDependencies {
  readonly tokenizer: Tokenizer;
  readonly config: PiiConfig;
  readonly resolver: AuditingVaultResolver;
}

/** Tokenizes before persistence and resolves only allowlisted pointers in memory. */
export class PiiToolPort implements PiiToolPortLike {
  constructor(
    private readonly inner: PiiToolPortLike,
    private readonly deps: PiiToolPortDependencies,
  ) {}

  /** Forwards retry and timeout metadata. */
  describe(toolId: Code): ReturnType<PiiToolPortLike["describe"]> {
    return this.inner.describe(toolId);
  }

  /** Forwards provider-visible tool specifications. */
  getToolSpecs(): readonly ToolSpec[] {
    return this.inner.getToolSpecs?.() ?? [];
  }

  /** Produces the arguments that may enter the durable log. */
  async prepare(call: PiiToolCall, context: PiiToolContext): Promise<PiiToolCall> {
    let tokenized;
    try {
      tokenized = await this.deps.tokenizer.tokenizeJson(context.runId, call.args, {
        boundary: "tool_input",
        destination: { tool: call.toolId },
      });
    } catch (error) {
      if (error instanceof PiiBlockedError) {
        await context.recordPiiAction?.({
          boundary: "tool_input",
          action: "block",
          entities: [...error.entities],
        });
      }
      throw error;
    }
    for (const summary of tokenized.actions) {
      await context.recordPiiAction?.(summary);
    }
    // An allow policy controls tool access, not permission to persist raw content.
    const stored = tokenized.actions.some(({ action }) => action === "allow")
      ? await this.deps.tokenizer.tokenizeJson(context.runId, tokenized.value, {
          boundary: "storage",
          destination: { tool: call.toolId },
        })
      : tokenized;
    const prepared = { ...call, args: stored.value };
    // Future policy decorators decide in prepare, while arguments still carry tokens.
    return this.inner.prepare?.(prepared, context) ?? prepared;
  }

  /** Resolves an ephemeral copy and sanitizes output before an outer offloader sees it. */
  async execute(call: PiiToolCall, context: PiiToolContext): Promise<PiiToolResult> {
    let args: JsonValue;
    try {
      const resolved = await detokenizeArgs(
        context.runId,
        call.toolId,
        call.args,
        this.deps.config,
        this.deps.resolver,
      );
      args = resolved.args;
    } catch (error) {
      // Arbitrary tool exception codes are attacker-controlled, even when regex-valid.
      const code = error instanceof PiiTokenUnresolvableError ? error.code : "pii_vault_failed";
      return { outcome: "error", errorCode: code, result: null };
    }
    let execution: PiiToolResult;
    try {
      execution = await this.inner.execute({ ...call, args }, context);
    } catch (error) {
      if (context.signal.aborted) {
        throw error;
      }
      return { outcome: "error", errorCode: "tool_failed", result: null };
    }
    if (execution.binary === true) {
      return binaryResult(execution);
    }
    try {
      const tokenized = await this.deps.tokenizer.tokenizeJson(context.runId, execution.result, {
        boundary: "tool_output",
        destination: { tool: call.toolId },
      });
      for (const summary of tokenized.actions) {
        await context.recordPiiAction?.(summary);
      }
      const stored = tokenized.actions.some(({ action }) => action === "allow")
        ? await this.deps.tokenizer.tokenizeJson(context.runId, tokenized.value, {
            boundary: "storage",
            destination: { tool: call.toolId },
          })
        : tokenized;
      return {
        outcome: execution.outcome,
        result: stored.value,
        ...(execution.outcome === "error" ? { errorCode: "tool_failed" } : {}),
      };
    } catch (error) {
      if (error instanceof PiiBlockedError || error instanceof PiiTokenizerError) {
        if (error instanceof PiiBlockedError) {
          await context.recordPiiAction?.({
            boundary: "tool_output",
            action: "block",
            entities: [...error.entities],
          });
        }
        return { outcome: "error", errorCode: error.code, result: null };
      }
      throw error;
    }
  }
}

function binaryResult(execution: PiiToolResult): PiiToolResult {
  const payload = ToolBinaryPayloadSchema.safeParse(execution.result);
  if (!payload.success) {
    return { outcome: "error", errorCode: "pii_input_invalid", result: null };
  }
  return {
    outcome: execution.outcome,
    result: payload.data,
    binary: true,
    ...(execution.outcome === "error" ? { errorCode: "tool_failed" } : {}),
  };
}
