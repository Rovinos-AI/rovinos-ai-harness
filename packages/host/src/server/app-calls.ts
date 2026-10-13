// SPDX-License-Identifier: Apache-2.0
import { Code, HarnessError, Id } from "@harness/schemas";
import { metrics, type Counter } from "@opentelemetry/api";
import type { CallToolResult, ListToolsResult, Tool } from "@modelcontextprotocol/client";
import { isToolVisibilityModelOnly } from "@modelcontextprotocol/ext-apps/app-bridge";
import { z } from "zod";
import type { HostConfig } from "@harness/schemas";
import type { AppCall, AppInstance } from "./types.js";

/** Name of the host-local telemetry tool exposed to MCP Apps. */
export const APP_TELEMETRY_TOOL_NAME = "harness.telemetry.emit";

/** Arguments accepted by the host-local telemetry tool before span validation. */
export const AppTelemetryEmitArgsSchema = z.object({ spans: z.array(z.unknown()) }).strict();

/** MCP tool metadata marks this declaration as callable by the app, not the model. */
export const APP_TELEMETRY_TOOL = {
  name: APP_TELEMETRY_TOOL_NAME,
  description: "Emit telemetry spans from this app through the host.",
  inputSchema: z.toJSONSchema(AppTelemetryEmitArgsSchema) as Tool["inputSchema"],
  _meta: { ui: { visibility: ["app"] } },
} satisfies Tool;

/** Policy context for an app-originated tool call. */
export interface AppCallPolicyContext {
  readonly subagent: false;
  readonly app: Code;
}

/** Host-controlled execution context passed to app-call handlers. */
export interface AppCallExecutionContext {
  readonly runId: Id;
  readonly policyContext: AppCallPolicyContext;
}

/** Bounded rejection reasons emitted for app tool calls. */
export type AppCallRejectedReason = "unknown_tool";

interface AppCallRejectedAttributes extends Readonly<Record<string, AppCallRejectedReason>> {
  readonly reason: AppCallRejectedReason;
}

let appRejectedCounter: Counter<AppCallRejectedAttributes> | undefined;

function countAppRejection(reason: AppCallRejectedReason): void {
  try {
    appRejectedCounter ??= metrics
      .getMeter("@harness/host")
      .createCounter<AppCallRejectedAttributes>("harness.host.app_rejected");
    appRejectedCounter.add(1, { reason });
  } catch {
    return;
  }
}

/** Error codes returned when an app tool call fails the host boundary. */
export type AppCallRouterErrorCode =
  | "app_tool_not_allowed"
  | "app_run_mismatch"
  | "app_run_unavailable";

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
  readonly onAppCall?: (
    call: AppCall,
    context: AppCallExecutionContext,
  ) => Promise<CallToolResult>;
  /** Consumes telemetry locally; this callback must not forward to an MCP server. */
  readonly onTelemetryEmit?: (
    session: AppInstance,
    args: z.infer<typeof AppTelemetryEmitArgsSchema>,
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
      const parsed = AppTelemetryEmitArgsSchema.safeParse(request.arguments);
      if (!parsed.success) {
        return { content: [], isError: true };
      }
      return (
        (await this.#options.onTelemetryEmit?.(session, parsed.data, context)) ?? {
          content: [],
          isError: true,
        }
      );
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
      app === undefined ||
      session.resourceUri !== app.resourceUri ||
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
      tools:
        cursor === undefined && app.telemetry
          ? [...tools, APP_TELEMETRY_TOOL]
          : tools,
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
    const ids = [request.callId, request.approvalId, ...(request.approvalIds ?? [])];
    for (const id of ids) {
      if (id !== undefined) {
        try {
          if (
            this.#options.isIdOwnedByRun === undefined ||
            !(await this.#options.isIdOwnedByRun(runId, id))
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
    countAppRejection("unknown_tool");
    try {
      this.#options.onRejected?.("unknown_tool");
    } catch {
      return;
    }
  }
}
