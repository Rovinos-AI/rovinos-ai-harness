// SPDX-License-Identifier: Apache-2.0
import {
  ApprovalPayloadSchema,
  Code,
  ResolveResponse,
  RevealResponse,
  type Id,
  type JsonValue,
  type ResolveRequest,
} from "@harness/schemas";
import { findTokens, type AuditingVaultResolver } from "@harness/vault";
import { applyApprovalEdits, approvalEditsAreAllowed } from "@harness/policy";
import type { ApprovalAppAudit, ApprovalAppToolOptions } from "./approvals-app.js";
import type { ConfirmationRequest } from "../confirmation-gate.js";
import type { ServerContext } from "@modelcontextprotocol/server";
import type { findApprovalRequest } from "./run-state.js";

const MAX_REVEAL_TOKENS = 20;

/** Finds a JSON pointer only when every segment exists in the supplied value. */
export function findValueAtPointer(value: JsonValue, pointer: string): JsonValue | undefined {
  if (pointer.length === 0) {
    return undefined;
  }
  let current: JsonValue | undefined = value;
  for (const segment of pointer
    .slice(1)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))) {
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/u.test(segment)) {
        return undefined;
      }
      const index = Number(segment);
      current = Number.isSafeInteger(index) && index >= 0 ? current[index] : undefined;
    } else if (
      typeof current === "object" &&
      current !== null &&
      Object.hasOwn(current, segment)
    ) {
      current = current[segment];
    } else {
      return undefined;
    }
    if (current === undefined) {
      return undefined;
    }
  }
  return current;
}

/** Reconstructs selected text around resolved token occurrences. */
export function replaceTokens(
  value: string,
  matches: ReturnType<typeof findTokens>,
  resolved: ReadonlyMap<string, string>,
): string {
  let offset = 0;
  let result = "";
  for (const match of matches) {
    result += value.slice(offset, match.index) + (resolved.get(match.token) ?? match.token);
    offset = match.index + match.token.length;
  }
  return result + value.slice(offset);
}

/** Produces and audits a metadata-only resolve result. */
export function decisionResult(
  options: ApprovalAppToolOptions,
  result: {
    readonly tokenId: Code;
    readonly tool: Code;
    readonly ok: boolean;
    readonly code?: string;
  },
): {
  readonly structuredContent: ReturnType<typeof ResolveResponse.parse>;
  readonly content: [{ type: "text"; text: string }];
  readonly isError?: true;
} {
  const output = ResolveResponse.parse({
    ok: result.ok,
    ...(result.code === undefined ? {} : { code: Code.parse(result.code) }),
  });
  audit(options, {
    tokenId: result.tokenId,
    tool: result.tool,
    outcome: Code.parse(result.code ?? (result.ok ? "ok" : "failed")),
    count: 0,
  });
  return {
    structuredContent: output,
    content: [
      {
        type: "text" as const,
        text: result.code ?? (result.ok ? "Decision recorded." : "No change."),
      },
    ],
    ...(result.ok ? {} : { isError: true }),
  };
}

/** Produces and audits a metadata-only reveal result. */
export function revealResult(
  options: ApprovalAppToolOptions,
  result: {
    readonly tokenId: Code;
    readonly ok: boolean;
    readonly code?: string;
    readonly values: RevealResponse["values"];
  },
): {
  readonly structuredContent: ReturnType<typeof RevealResponse.parse>;
  readonly content: [{ type: "text"; text: string }];
  readonly isError?: true;
} {
  const output = RevealResponse.parse({ values: result.ok ? result.values : [] });
  audit(options, {
    tokenId: result.tokenId,
    tool: Code.parse("harness.approvals.reveal"),
    outcome: Code.parse(result.code ?? (result.ok ? "ok" : "failed")),
    count: result.values.length,
  });
  return {
    structuredContent: output,
    content: [
      {
        type: "text" as const,
        text: result.code ?? `Revealed ${String(result.values.length)} values.`,
      },
    ],
    ...(result.ok ? {} : { isError: true }),
  };
}

/** Sends one bounded metadata-only record to the configured audit sink. */
export function audit(options: ApprovalAppToolOptions, entry: ApprovalAppAudit): void {
  options.onAudit(entry);
}

/** Resolves valid PII tokens from selected stored approval strings. */
export async function resolveSelectedValues(
  input: {
    readonly vaultResolver: AuditingVaultResolver;
    readonly runId: Id;
    readonly args: JsonValue;
    readonly toolId: Code;
    readonly pointers: readonly string[];
  },
): Promise<
  | { readonly success: true; readonly values: RevealResponse["values"] }
  | { readonly success: false; readonly code: string }
> {
  const selected = input.pointers.map((pointer) => ({
    pointer,
    value: findValueAtPointer(input.args, pointer),
  }));
  const matches = selected.map(({ value }) =>
    typeof value === "string" ? findTokens(value) : [],
  );
  if (
    selected.some(({ value }, index) => typeof value !== "string" || matches[index]?.length === 0)
  ) {
    return { success: false, code: "pointer_invalid" };
  }
  const occurrences = matches.flat();
  if (occurrences.length > MAX_REVEAL_TOKENS) {
    return { success: false, code: "pointer_invalid" };
  }
  const tokens = [...new Set(occurrences.map(({ token }) => token))];
  try {
    const values = await input.vaultResolver.resolveMany(input.runId, tokens, {
      boundary: "ui",
      toolId: input.toolId,
    });
    if (values.some((value) => value === undefined)) {
      return { success: false, code: "reveal_value_unavailable" };
    }
    const resolved = new Map(
      tokens.flatMap((token, index) => {
        const value = values[index];
        return value === undefined ? [] : [[token, value] as const];
      }),
    );
    return {
      success: true,
      values: selected.flatMap(({ pointer, value }, index) =>
        typeof value === "string"
          ? [{ pointer, value: replaceTokens(value, matches[index] ?? [], resolved) }]
          : [],
      ),
    };
  } catch (error) {
    return { success: false, code: safeErrorCode(error) };
  }
}

/** Validates and applies only stored, explicitly editable approval fields. */
export function resolveRequestedEdits(
  found: NonNullable<Awaited<ReturnType<typeof findApprovalRequest>>>,
  request: ResolveRequest,
): { readonly success: false } | { readonly success: true; readonly edits?: JsonValue } {
  if (request.decision !== "edit") {
    return { success: true };
  }
  const payload = ApprovalPayloadSchema.safeParse(found.request.payload);
  const applied =
    payload.success &&
    request.edits !== undefined &&
    approvalEditsAreAllowed(payload.data, request.edits)
      ? applyApprovalEdits(payload.data.args, request.edits)
      : { success: false as const };
  return applied.success ? { success: true, edits: applied.args } : { success: false };
}

/** Binds confirmation to the exact tool operation and the current client capabilities. */
export function requireHumanConfirmation(
  options: ApprovalAppToolOptions,
  context: ServerContext,
  request: Omit<ConfirmationRequest, "clientCapabilities">,
): ReturnType<ApprovalAppToolOptions["confirmationGate"]["requireHuman"]> {
  return options.confirmationGate.requireHuman(context, {
    ...request,
    clientCapabilities: options.clientCapabilities(context),
  });
}

/** Records that the tool request is waiting for a human decision. */
export function auditInputRequired(
  options: ApprovalAppToolOptions,
  tokenId: Code,
  tool: Code,
): void {
  audit(options, { tokenId, tool, outcome: Code.parse("input_required"), count: 0 });
}

/** Emits a safe code from typed errors and a generic fallback for unknown errors. */
export function safeErrorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const parsed = Code.safeParse(error.code);
    if (parsed.success) {
      return parsed.data;
    }
  }
  return "approval_operation_failed";
}
