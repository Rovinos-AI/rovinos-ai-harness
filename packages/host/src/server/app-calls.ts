// SPDX-License-Identifier: Apache-2.0
import {
  APP_TELEMETRY_TOOL_NAME,
  Code,
  HarnessError,
  Id,
  JsonValue,
  type HostConfig,
} from "@rovinos/schemas";
import { countHostAppRejected, type HostAppRejectedReason } from "@rovinos/telemetry";
import type { CallToolResult, ListToolsResult, Tool } from "@modelcontextprotocol/client";
import { ToolSchema } from "@modelcontextprotocol/core";
import { isToolVisibilityModelOnly } from "@modelcontextprotocol/ext-apps/app-bridge";
import type {
  ModelToolCall,
  PolicyDecision,
  PolicyPort,
  RunContext,
  ToolPort,
} from "@rovinos/core";
import { z } from "zod";
import { AppSpanBatchSchema } from "./app-telemetry.js";
import type { AppCall, AppInstance } from "./types.js";

export { APP_TELEMETRY_TOOL_NAME };

/** Arguments accepted by the host-local telemetry tool before span validation. */
export const AppTelemetryEmitArgsSchema = AppSpanBatchSchema;

/** MCP tool metadata marks this declaration as callable by the app, not the model. */
export const APP_TELEMETRY_TOOL: Tool = ToolSchema.parse({
  name: APP_TELEMETRY_TOOL_NAME,
  description: "Emit telemetry spans from this app through the host.",
  inputSchema: z.toJSONSchema(AppTelemetryEmitArgsSchema),
  _meta: { ui: { visibility: ["app"] } },
});

/** Policy context for an app-originated tool call. */
export interface AppCallPolicyContext {
  readonly subagent: false;
  readonly app: Code;
}

/** Suspends an app call for durable approval and returns its resumed tool result. */
export type AppCallApprovalHandler = (
  call: ModelToolCall,
  decision: PolicyDecision,
  context: AppCallExecutionContext,
) => Promise<CallToolResult>;

/** Host-controlled execution context passed to app-call handlers. */
export interface AppCallExecutionContext {
  readonly runId: Id;
  readonly policyContext: AppCallPolicyContext;
}

/** Bounded rejection reasons emitted for app tool calls. */
export type AppCallRejectedReason = HostAppRejectedReason | "telemetry_unavailable";

/** Error codes returned when an app tool call fails the host boundary. */
export type AppCallRouterErrorCode =
  | "app_tool_not_allowed"
  | "app_run_mismatch"
  | "app_run_unavailable"
  | "app_telemetry_unavailable"
  | "rate_limited";

/** Safe error raised when an app call violates its host session policy. */
export class AppCallRouterError extends HarnessError {
  readonly code: AppCallRouterErrorCode;

  /**
   * Creates an app-call boundary error without retaining request contents.
   *
   * @param code - Closed app-call failure code.
   */
  constructor(code: AppCallRouterErrorCode) {
    super("The app tool call was rejected by the host.");
    this.code = code;
  }
}

/** Dependencies used to handle calls from an MCP App session. */
export interface AppCallRouterOptions {
  /** Validated app configurations keyed by app id. */
  readonly apps: ReadonlyMap<string, HostConfig["apps"][number]>;
  /** Executes an allowlisted call through the run's policy-aware tool pipeline. */
  readonly onAppCall?: (call: AppCall, context: AppCallExecutionContext) => Promise<CallToolResult>;
  /** Replaces default ingestion; validate with `ingestBatch`, keep input local, and return its acknowledgment. */
  readonly onTelemetryEmit?: (
    session: AppInstance,
    args: unknown,
    context: AppCallExecutionContext,
  ) => Promise<CallToolResult>;
  /** Reads tools available to an app; the router applies its app-specific allowlist. */
  readonly onAppToolsList?: (
    appId: Code,
    allowedTools: readonly Code[],
    cursor?: string,
  ) => Promise<ListToolsResult>;
  /** Verifies that a call or approval identifier belongs to the active run. */
  readonly isIdOwnedByRun?: (runId: Id, id: Id) => boolean | Promise<boolean>;
  /** Observes bounded app-call rejections. */
  readonly onRejected?: (reason: AppCallRejectedReason) => void;
}

/** Dependencies for executing app calls through the normal preparation and policy ports. */
export interface PolicyCheckedAppCallHandlerOptions {
  readonly policy: PolicyPort;
  readonly tool: ToolPort;
  readonly nextCallId: () => Id;
  /**
   * Persists the approval and suspends/resumes the run before returning the app result.
   * When omitted, the host cannot suspend and fails closed with `app_call_requires_approval`.
   */
  readonly onAppCallApproval?: AppCallApprovalHandler;
}

function callError(code: string): CallToolResult {
  return { content: [{ type: "text", text: code }], isError: true };
}

function makeModelToolCall(
  request: AppCall,
  toolId: Code,
  nextCallId: () => Id,
): ModelToolCall | undefined {
  try {
    return {
      callId: request.callId ?? nextCallId(),
      toolId,
      args: JsonValue.parse(request.arguments),
    };
  } catch {
    return undefined;
  }
}

async function prepareAppToolCall(
  tool: ToolPort,
  call: ModelToolCall,
  context: RunContext,
): Promise<ModelToolCall | undefined> {
  try {
    return (await tool.prepare?.(call, context)) ?? call;
  } catch {
    return undefined;
  }
}

function decideAppToolCall(
  policy: PolicyPort,
  call: ModelToolCall,
  context: AppCallExecutionContext,
): ReturnType<PolicyPort["decide"]> | undefined {
  try {
    return policy.decide({ toolId: call.toolId, args: call.args }, context.policyContext);
  } catch {
    return undefined;
  }
}

async function executeAllowedAppToolCall(
  tool: ToolPort,
  call: ModelToolCall,
  context: RunContext,
): Promise<CallToolResult> {
  try {
    const result = await tool.execute(call, context);
    if (result.outcome === "error") {
      return callError(result.errorCode ?? "app_tool_failed");
    }
    return { content: [{ type: "text", text: JSON.stringify(result.result) }] };
  } catch {
    return callError("app_tool_failed");
  }
}

/**
 * Creates the host-side app handler that prepares arguments and applies policy before execution.
 *
 * Policy `ask` decisions use the supplied durable approval handler. Hosts without one fail closed
 * with `app_call_requires_approval`.
 *
 * @param options - Policy, tool pipeline, and injected call ID generator.
 * @returns An app-call handler suitable for {@link AppCallRouterOptions.onAppCall}.
 */
export function createPolicyCheckedAppCallHandler(
  options: PolicyCheckedAppCallHandlerOptions,
): NonNullable<AppCallRouterOptions["onAppCall"]> {
  return async (request, context) => {
    const toolId = Code.safeParse(request.toolName);
    if (!toolId.success || options.tool.describe(toolId.data) === undefined) {
      return callError("unknown_tool");
    }
    const call = makeModelToolCall(request, toolId.data, options.nextCallId);
    if (call === undefined) {
      return callError("app_tool_arguments_invalid");
    }
    const runContext: RunContext = {
      runId: context.runId,
      signal: new AbortController().signal,
    };
    const prepared = await prepareAppToolCall(options.tool, call, runContext);
    if (prepared === undefined) {
      return callError("app_tool_prepare_failed");
    }
    if (prepared.toolId !== toolId.data) {
      return callError("unknown_tool");
    }
    const decision = decideAppToolCall(options.policy, prepared, context);
    if (decision === undefined) {
      return callError("policy_error");
    }
    if (decision.decision === "deny") {
      return callError(decision.reason);
    }
    if (decision.decision === "ask") {
      if (options.tool.prepare === undefined) {
        return callError("app_call_requires_approval");
      }
      return (
        (await options.onAppCallApproval?.(prepared, decision, context)) ??
        callError("app_call_requires_approval")
      );
    }
    return executeAllowedAppToolCall(options.tool, prepared, runContext);
  };
}

/**
 * Routes app calls locally or through the policy-aware tool pipeline.
 */
export class AppCallRouter {
  readonly #options: AppCallRouterOptions;

  /** Creates a router bound to validated app settings and host call handlers. */
  constructor(options: AppCallRouterOptions) {
    this.#options = options;
  }

  /**
   * Handles one app call, keeping telemetry local and enforcing the app allowlist.
   *
   * @param session - Host-owned app session and run binding.
   * @param request - Parsed app call with untrusted tool arguments.
   * @returns MCP result from the local handler or allowed tool pipeline.
   * @throws {AppCallRouterError} If the call is disallowed or refers to a different run.
   */
  async handle(session: AppInstance, request: AppCall): Promise<CallToolResult> {
    const app = this.#options.apps.get(session.id);
    if (
      app === undefined ||
      session.sessionId !== request.sessionId ||
      session.id !== request.appId
    ) {
      throw new AppCallRouterError("app_tool_not_allowed");
    }
    if (request.toolName !== APP_TELEMETRY_TOOL_NAME) {
      const requestedTool = Code.safeParse(request.toolName);
      if (!requestedTool.success || !app.allowedTools.includes(requestedTool.data)) {
        this.#rejectUnknownTool();
        throw new AppCallRouterError("app_tool_not_allowed");
      }
    }

    const context = this.#executionContext(session, request.runId, app.id);
    await this.#validateScopedIds(context.runId, request);

    if (request.toolName === APP_TELEMETRY_TOOL_NAME) {
      if (!app.telemetry) {
        this.#rejectUnknownTool();
        throw new AppCallRouterError("app_tool_not_allowed");
      }
      if (this.#options.onTelemetryEmit === undefined) {
        this.#reject("telemetry_unavailable");
        throw new AppCallRouterError("app_telemetry_unavailable");
      }
      return this.#options.onTelemetryEmit(session, request.arguments, context);
    }

    return (
      (await this.#options.onAppCall?.(request, context)) ?? {
        content: [],
        isError: true,
      }
    );
  }

  /**
   * Lists only tools allowed to the app; an empty allowlist yields no discoveries.
   *
   * @param session - Host-owned app session.
   * @param cursor - Optional MCP paging cursor.
   * @returns Tool list filtered to the session app's allowlist.
   */
  async listTools(session: AppInstance, cursor?: string): Promise<ListToolsResult> {
    const app = this.#options.apps.get(session.id);
    if (
      app?.resourceUri !== session.resourceUri ||
      session.sessionId.length === 0 ||
      app.allowedTools.length === 0
    ) {
      return { tools: [] };
    }
    const result = await this.#options.onAppToolsList?.(app.id, app.allowedTools, cursor);
    if (result === undefined) {
      return { tools: [] };
    }
    const allowed = new Set<string>(app.allowedTools);
    const tools = result.tools.filter(
      (tool) =>
        allowed.has(tool.name) &&
        tool.name !== APP_TELEMETRY_TOOL_NAME &&
        !isToolVisibilityModelOnly(tool),
    );
    return {
      tools: cursor === undefined && app.telemetry ? [...tools, APP_TELEMETRY_TOOL] : tools,
      ...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }),
    };
  }

  #executionContext(
    session: AppInstance,
    requestRunId: Id | undefined,
    appId: Code,
  ): AppCallExecutionContext {
    if (session.runId === undefined) {
      throw new AppCallRouterError("app_run_unavailable");
    }
    if (requestRunId !== undefined && requestRunId !== session.runId) {
      throw new AppCallRouterError("app_run_mismatch");
    }
    return {
      runId: session.runId,
      policyContext: { subagent: false, app: appId },
    };
  }

  async #validateScopedIds(runId: Id, request: AppCall): Promise<void> {
    const args = request.arguments;
    if (Object.hasOwn(args, "runId")) {
      const argumentRunId = Id.safeParse(args.runId);
      if (!argumentRunId.success || argumentRunId.data !== runId) {
        throw new AppCallRouterError("app_run_mismatch");
      }
    }
    const ids: unknown[] = [request.callId, request.approvalId, ...(request.approvalIds ?? [])];
    for (const name of ["callId", "approvalId"] as const) {
      if (Object.hasOwn(args, name)) {
        ids.push(args[name]);
      }
    }
    if (Object.hasOwn(args, "approvalIds")) {
      const approvalIds = z.array(z.unknown()).safeParse(args.approvalIds);
      if (!approvalIds.success) {
        throw new AppCallRouterError("app_run_mismatch");
      }
      ids.push(...approvalIds.data);
    }
    for (const value of ids) {
      if (value !== undefined) {
        const id = Id.safeParse(value);
        if (!id.success) {
          throw new AppCallRouterError("app_run_mismatch");
        }
        try {
          if (
            this.#options.isIdOwnedByRun === undefined ||
            !(await this.#options.isIdOwnedByRun(runId, id.data))
          ) {
            throw new AppCallRouterError("app_run_mismatch");
          }
        } catch {
          throw new AppCallRouterError("app_run_mismatch");
        }
      }
    }
  }

  #rejectUnknownTool(): void {
    this.#reject("unknown_tool");
  }

  #reject(reason: AppCallRejectedReason): void {
    if (reason !== "telemetry_unavailable") {
      countHostAppRejected(reason);
    }
    try {
      this.#options.onRejected?.(reason);
    } catch {
      return;
    }
  }
}
