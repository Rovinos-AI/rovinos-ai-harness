// SPDX-License-Identifier: Apache-2.0
import type { Runtime } from "@harness/core";
import {
  ApprovalPayloadSchema,
  Code,
  HarnessError,
  HostConfigSchema,
  Id,
  JsonValue,
  ResolveRequest,
  ResolveResponse,
  RevealRequest,
  RevealResponse,
  type Event,
} from "@harness/schemas";
import type { HarnessConfig } from "@harness/config";
import { applyApprovalEdits, approvalEditsAreAllowed } from "@harness/policy";
import { Token } from "@harness/vault";
import { ListToolsResultSchema } from "@modelcontextprotocol/core";
import { z } from "zod";
import type { CliContext } from "../command.js";

const APPROVAL_APP_ID = Code.parse("harness.approval");
const RESOLVE_TOOL = "harness.approvals.resolve";
const REVEAL_TOOL = "harness.approvals.reveal";
const REVEAL_WINDOW_MS = 60_000;
const REVEAL_LIMIT = 5;

class ApprovalViewError extends HarnessError {
  override readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

/** Starts the local MCP Apps approval view for one currently pending approval. */
export async function createApprovalViewHost(
  runtime: Runtime,
  context: CliContext,
  config: HarnessConfig,
  runId: Id,
  approvalId: Id,
): Promise<{ readonly url: string; close(): Promise<void> }> {
  const pending = await findPendingApproval(runtime, runId, approvalId);
  const payload = ApprovalPayloadSchema.parse(pending.payload);
  const { createReferenceHost } = await import("@harness/host");
  const { APPROVAL_RESOURCE_URI, MCP_APP_HTML_MIME_TYPE, loadApprovalHtml } =
    await import("@harness/control-plane");
  const appConfig = HostConfigSchema.parse({
    apps: [
      {
        id: APPROVAL_APP_ID,
        resourceUri: APPROVAL_RESOURCE_URI,
        telemetry: true,
        allowedTools: [RESOLVE_TOOL, REVEAL_TOOL],
        allow: { openLink: false, message: false, modelContext: false },
      },
    ],
  });
  const tools = ListToolsResultSchema.parse({
    tools: [
      {
        name: RESOLVE_TOOL,
        description: "Resolve this pending approval.",
        inputSchema: zodJsonSchema(ResolveRequest),
        _meta: { ui: { visibility: ["app"] } },
      },
      {
        name: REVEAL_TOOL,
        description: "Reveal selected values from this approval.",
        inputSchema: zodJsonSchema(RevealRequest),
        _meta: { ui: { visibility: ["app"] } },
      },
    ],
  });
  const revealRequests = new Map<string, number[]>();
  const host = await createReferenceHost(appConfig, {
    readResource: async (resourceUri) => ({
      contents: [
        {
          uri: resourceUri,
          mimeType: MCP_APP_HTML_MIME_TYPE,
          text: loadApprovalHtml(),
        },
      ],
    }),
    onCode: (code) => context.out.error(code),
    runId,
    toolInput: { approvalId, payload },
    hasPendingApproval: (id) => runtime.hasPendingApproval(id),
    tokenizeAppContent: (id, content, boundary) =>
      runtime.tokenizeAppContent(id, content, boundary),
    onAppContent: (content) => runtime.onAppContent(content),
    isIdOwnedByRun: (id, candidate) => id === runId && candidate === approvalId,
    onAppToolsList: async () => tools,
    onAppCall: (call, callContext) =>
      handleApprovalCall({
        runtime,
        context,
        config,
        runId,
        approvalId,
        revealRequests,
        sessionId: call.sessionId,
        toolName: call.toolName,
        arguments: call.arguments,
        callRunId: callContext.runId,
      }),
  });
  return { url: host.url, close: host.close };
}

function zodJsonSchema(schema: typeof ResolveRequest | typeof RevealRequest) {
  return JsonValue.parse(z.toJSONSchema(schema));
}

async function findPendingApproval(
  runtime: Runtime,
  runId: Id,
  approvalId: Id,
): Promise<Extract<Event, { type: "approval_requested" }>> {
  const events = await readApprovalEvents(runtime, runId);
  if (events.length === 0) {
    throw new ApprovalViewError("approval_not_found");
  }
  const { foldRunState } = await import("@harness/core");
  const state = foldRunState(events);
  const approval = events.find(
    (event): event is Extract<Event, { type: "approval_requested" }> =>
      event.type === "approval_requested" && event.approvalId === approvalId,
  );
  if (approval === undefined || !state.pendingApprovals.has(approvalId)) {
    throw new ApprovalViewError("approval_not_found");
  }
  return approval;
}

async function readApprovalEvents(runtime: Runtime, runId: Id) {
  const events = [];
  for await (const event of runtime.store.read(runId)) {
    events.push(event);
  }
  return events;
}

async function handleApprovalCall(options: {
  readonly runtime: Runtime;
  readonly context: CliContext;
  readonly config: HarnessConfig;
  readonly runId: Id;
  readonly approvalId: Id;
  readonly revealRequests: Map<string, number[]>;
  readonly sessionId: string;
  readonly toolName: string;
  readonly arguments: Record<string, unknown>;
  readonly callRunId: Id;
}) {
  if (options.callRunId !== options.runId) {
    return toolError("approval_not_found");
  }
  if (options.toolName === RESOLVE_TOOL) {
    return resolveApprovalCall(options);
  }
  if (options.toolName === REVEAL_TOOL) {
    return revealApprovalCall(options);
  }
  return toolError("approval_tool_unavailable");
}

async function resolveApprovalCall(options: {
  readonly runtime: Runtime;
  readonly runId: Id;
  readonly approvalId: Id;
  readonly arguments: Record<string, unknown>;
}) {
  const request = ResolveRequest.safeParse(options.arguments);
  if (!request.success || request.data.approvalId !== options.approvalId) {
    return resolveError("approval_not_found");
  }
  try {
    const approval = await findPendingApproval(options.runtime, options.runId, options.approvalId);
    const payload = ApprovalPayloadSchema.parse(approval.payload);
    let edits: JsonValue | undefined;
    if (request.data.decision === "edit") {
      const applied =
        request.data.edits !== undefined &&
        approvalEditsAreAllowed(payload, request.data.edits)
          ? applyApprovalEdits(payload.args, request.data.edits)
          : { success: false as const };
      if (!applied.success) {
        return resolveError("edit_not_allowed");
      }
      edits = applied.args;
    }
    await options.runtime.resolveApproval(options.runId, options.approvalId, request.data.decision, {
      ...(edits === undefined ? {} : { edits }),
      metadata: { decidedBy: "human" },
    });
    return {
      structuredContent: ResolveResponse.parse({ ok: true }),
      content: [{ type: "text" as const, text: "Decision recorded." }],
    };
  } catch (error) {
    return resolveError(errorCode(error));
  }
}

async function revealApprovalCall(options: {
  readonly runtime: Runtime;
  readonly context: CliContext;
  readonly config: HarnessConfig;
  readonly runId: Id;
  readonly approvalId: Id;
  readonly revealRequests: Map<string, number[]>;
  readonly sessionId: string;
  readonly arguments: Record<string, unknown>;
}) {
  const request = RevealRequest.safeParse(options.arguments);
  if (
    options.config.controlPlane?.allowReveal !== true ||
    !request.success ||
    request.data.approvalId !== options.approvalId
  ) {
    return revealError("reveal_disabled");
  }
  const now = options.context.clock.now();
  const recent = (options.revealRequests.get(options.sessionId) ?? []).filter(
    (timestamp) => timestamp > now - REVEAL_WINDOW_MS,
  );
  if (recent.length >= REVEAL_LIMIT) {
    return revealError("rate_limited");
  }
  recent.push(now);
  options.revealRequests.set(options.sessionId, recent);
  if (
    options.config.controlPlane?.reveal.requireElicitation !== false &&
    (options.context.interactive?.isTTY !== true ||
      !(await options.context.interactive.confirm(
        `Reveal ${String(request.data.pointers.length)} values from this approval?`,
      )))
  ) {
    return revealError("human_confirmation_unavailable");
  }
  try {
    const approval = await findPendingApproval(options.runtime, options.runId, options.approvalId);
    const payload = ApprovalPayloadSchema.parse(approval.payload);
    const selected = request.data.pointers.map((pointer) => ({
    pointer,
    value: valueAtPointer(payload.args, pointer),
    }));
    const tokens = [];
    for (const { value } of selected) {
    const token = Token.safeParse(value);
    if (!token.success) {
      return revealError("pointer_invalid");
    }
    tokens.push(token.data);
    }
    const values = await options.runtime.vault.resolveMany(options.runId, tokens, {
    boundary: "ui",
    });
    if (values.some((value) => value === undefined)) {
      return revealError("reveal_value_unavailable");
    }
    return {
      structuredContent: RevealResponse.parse({
        values: selected.flatMap(({ pointer }, index) => {
          const value = values[index];
          return value === undefined ? [] : [{ pointer, value }];
        }),
      }),
      content: [{ type: "text" as const, text: `Revealed ${String(values.length)} values.` }],
    };
  } catch (error) {
    return revealError(errorCode(error));
  }
}

function valueAtPointer(value: JsonValue, pointer: string): JsonValue | undefined {
  if (pointer.length === 0) {
    return undefined;
  }
  let current: JsonValue | undefined = value;
  for (const segment of pointer
    .slice(1)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))) {
    if (Array.isArray(current) && /^(?:0|[1-9]\d*)$/u.test(segment)) {
      const index = Number(segment);
      current = Number.isSafeInteger(index) ? current[index] : undefined;
    } else if (
      typeof current === "object" &&
      current !== null &&
      !Array.isArray(current) &&
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

function resolveError(code: string) {
  const output = ResolveResponse.parse({ ok: false, code: Code.parse(code) });
  return {
    structuredContent: output,
    content: [{ type: "text" as const, text: code }],
    isError: true,
  };
}

function revealError(code: string) {
  return {
    structuredContent: RevealResponse.parse({ values: [] }),
    content: [{ type: "text" as const, text: code }],
    isError: true,
  };
}

function toolError(code: string) {
  return { content: [{ type: "text" as const, text: code }], isError: true };
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const parsed = Code.safeParse(error.code);
    if (parsed.success) {
      return parsed.data;
    }
  }
  return "approval_operation_failed";
}
