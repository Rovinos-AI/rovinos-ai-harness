// SPDX-License-Identifier: Apache-2.0
import { Code, Principal } from "@rovinos/schemas";
import type { EventStore } from "@rovinos/store";
import { CLIENT_CAPABILITIES_META_KEY, McpServer } from "@modelcontextprotocol/server";
import type { ServerContext } from "@modelcontextprotocol/server";
import { serveStdio, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { emitApprovalAppAudit, emitControlPlaneAudit } from "@rovinos/telemetry";
import {
  type ConfirmationClientCapabilities,
  ConfirmationGate,
  confirmationClientCapabilitiesSchema,
} from "./confirmation-gate.js";
import { filterToolsForClient } from "./capabilities.js";
import { RunSupervisor } from "./run-supervisor.js";
import { registerApproveTool } from "./tools/approve.js";
import { registerReviewApprovalTool } from "./tools/review-approval.js";
import { registerCancelRunTool } from "./tools/cancel-run.js";
import { registerDenyTool } from "./tools/deny.js";
import { registerGetRunTool } from "./tools/get-run.js";
import { registerListRunsTool } from "./tools/list-runs.js";
import { registerResumeRunTool } from "./tools/resume-run.js";
import { registerStartRunTool } from "./tools/start-run.js";
import { registerContinueRunTool } from "./tools/continue-run.js";
import { registerAnswerInputTool } from "./tools/answer-input.js";
import { registerGetInputTool } from "./tools/get-input.js";
import { registerListPendingInputsTool } from "./tools/list-pending-inputs.js";
import { registerReviewInputTool } from "./tools/review-input.js";
import { registerApprovalAppTools, ApprovalAppRevealRateLimiter } from "./tools/approvals-app.js";
import { loadApprovalHtml, registerApprovalResource } from "./resources/approval.js";
import { loadRunsConsoleHtml, registerRunsConsoleResource } from "./resources/runs-console.js";
import { registerRunResources } from "./resources/runs.js";
import { configureRunResourceUpdates } from "./resources/server-updates.js";
import { controlPlanePrincipal, hasControlPlaneScope } from "./auth.js";
import { startControlPlaneHttpTransport, type ControlPlaneHttpHandle } from "./http-server.js";
import { toolDefinitions, toolScope } from "./tool-definitions.js";
import type { ControlPlaneServerOptions } from "./server-types.js";

export type { ControlPlaneOperations, ControlPlaneServerOptions } from "./server-types.js";

export type { ControlPlaneHttpHandle };

/** Creates the MCP server with metadata-only inspection and confirmation-gated mutation tools. */
export function createControlPlaneServer(
  store: EventStore,
  options: ControlPlaneServerOptions = {},
): McpServer {
  const confirmationOptions = {
    ...options.confirmation,
    ...(options.isAppContext === undefined ? {} : { isAppContext: options.isAppContext }),
  };
  const confirmationGate =
    options.confirmationGate ?? new ConfirmationGate({ ...confirmationOptions, store });
  const server = new McpServer(
    {
      name: "rovinos-ai-harness-control-plane",
      version: "0.0.0",
    },
    { requestState: { verify: confirmationGate.verifyRequestState } },
  );
  server.server.registerCapabilities({ tools: {}, resources: { subscribe: true } });
  configureRunResourceUpdates(server, store, options);
  const clientCapabilities = (context: ServerContext): ConfirmationClientCapabilities | undefined =>
    requestClientCapabilities(context, server);
  registerRunInspection(server, store, options);
  registerRunResources(server, store, options.onAudit);
  registerConfiguredApprovalTools({
    server,
    store,
    options,
    confirmationGate,
    clientCapabilities,
  });
  registerInputTools({ server, store, options, confirmationGate, clientCapabilities });
  const supervisor = options.runSupervisor ?? createRunSupervisor(options);
  registerStartRunTool(server, {
    ...(options.operations?.startRun === undefined
      ? {}
      : { startRun: options.operations.startRun }),
    checkRunQuota: (requestedBy, role) =>
      options.operations?.checkRunQuota?.({
        requestedBy,
        ...(role === undefined ? {} : { role }),
      }) ?? Promise.resolve(),
    allowAgentStartedRuns: options.controlPlane?.allowAgentStartedRuns === true,
    confirmationGate,
    clientCapabilities,
    ...(options.onAudit === undefined ? {} : { onAudit: options.onAudit }),
  });
  registerContinueRunTool(server, {
    ...(options.operations?.continueRun === undefined
      ? {}
      : { continueRun: options.operations.continueRun }),
    checkRunQuota: (requestedBy) =>
      options.operations?.checkRunQuota?.({ requestedBy }) ?? Promise.resolve(),
    allowAgentStartedRuns: options.controlPlane?.allowAgentStartedRuns === true,
    confirmationGate,
    clientCapabilities,
    ...(options.onAudit === undefined ? {} : { onAudit: options.onAudit }),
  });
  registerLifecycleTools({
    server,
    store,
    options,
    confirmationGate,
    supervisor,
    clientCapabilities,
  });
  const definitions = toolDefinitions();
  server.server.setRequestHandler("tools/list", (_request, context) => {
    const capabilities = requestClientCapabilities(context, server);
    const principal = controlPlanePrincipal(context);
    return {
      tools: filterToolsForClient(definitions, capabilities).filter(
        (tool) => principal === undefined || hasControlPlaneScope(principal, toolScope(tool.name)),
      ),
    };
  });
  return server;
}

function registerRunInspection(
  server: McpServer,
  store: EventStore,
  options: ControlPlaneServerOptions,
): void {
  registerListRunsTool(server, store, options.onAudit);
  registerGetRunTool(server, store, options.onAudit);
  const now = (): number => options.clock?.now() ?? Date.now();
  registerListPendingInputsTool(server, store, now, options.onAudit);
  registerGetInputTool(server, store, now, options.onAudit);
  registerListRunsTool(server, store, options.onAudit, {
    name: "harness.runs.list",
    appOnly: true,
  });
  registerGetRunTool(server, store, options.onAudit, {
    name: "harness.runs.get",
    appOnly: true,
  });
  registerApprovalResource(server, options.approvalHtml ?? loadApprovalHtml());
  registerRunsConsoleResource(server, options.runsConsoleHtml ?? loadRunsConsoleHtml());
}

function registerInputTools(input: {
  readonly server: McpServer;
  readonly store: EventStore;
  readonly options: ControlPlaneServerOptions;
  readonly confirmationGate: ConfirmationGate;
  readonly clientCapabilities: (
    context: ServerContext,
  ) => ConfirmationClientCapabilities | undefined;
}): void {
  registerAnswerInputTool(input.server, {
    store: input.store,
    ...(input.options.operations?.resolveInput === undefined
      ? {}
      : { resolveInput: input.options.operations.resolveInput }),
    isAppContext: input.options.isAppContext ?? (() => false),
    ...(input.options.onAudit === undefined ? {} : { onAudit: input.options.onAudit }),
  });
  registerReviewInputTool(input.server, {
    store: input.store,
    confirmationGate: input.confirmationGate,
    ...(input.options.operations?.resolveInput === undefined
      ? {}
      : { resolveInput: input.options.operations.resolveInput }),
    clientCapabilities: input.clientCapabilities,
    ...(input.options.onAudit === undefined ? {} : { onAudit: input.options.onAudit }),
  });
}

function registerLifecycleTools(input: {
  readonly server: McpServer;
  readonly store: EventStore;
  readonly options: ControlPlaneServerOptions;
  readonly confirmationGate: ConfirmationGate;
  readonly supervisor: RunSupervisor;
  readonly clientCapabilities: (
    context: ServerContext,
  ) => ConfirmationClientCapabilities | undefined;
}): void {
  const resolveApproval = input.options.operations?.resolveApproval;
  const onAudit = input.options.onAudit;
  registerApproveTool(input.server, {
    store: input.store,
    confirmationGate: input.confirmationGate,
    ...(resolveApproval === undefined ? {} : { resolveApproval }),
    clientCapabilities: input.clientCapabilities,
    ...(onAudit === undefined ? {} : { onAudit }),
  });
  registerDenyTool(input.server, {
    store: input.store,
    confirmationGate: input.confirmationGate,
    ...(resolveApproval === undefined ? {} : { resolveApproval }),
    clientCapabilities: input.clientCapabilities,
    ...(onAudit === undefined ? {} : { onAudit }),
  });
  registerReviewApprovalTool(input.server, {
    store: input.store,
    confirmationGate: input.confirmationGate,
    ...(resolveApproval === undefined ? {} : { resolveApproval }),
    clientCapabilities: input.clientCapabilities,
    ...(input.options.consoleUrl === undefined ? {} : { consoleUrl: input.options.consoleUrl }),
    ...(onAudit === undefined ? {} : { onAudit }),
  });
  registerResumeRunTool(input.server, {
    confirmationGate: input.confirmationGate,
    supervisor: input.supervisor,
    clientCapabilities: input.clientCapabilities,
    ...(onAudit === undefined ? {} : { onAudit }),
  });
  registerCancelRunTool(input.server, {
    confirmationGate: input.confirmationGate,
    supervisor: input.supervisor,
    ...(input.options.operations?.cancelRun === undefined
      ? {}
      : { cancelRun: input.options.operations.cancelRun }),
    clientCapabilities: input.clientCapabilities,
    ...(onAudit === undefined ? {} : { onAudit }),
  });
}

function registerConfiguredApprovalTools(input: {
  readonly server: McpServer;
  readonly store: EventStore;
  readonly options: ControlPlaneServerOptions;
  readonly confirmationGate: ConfirmationGate;
  readonly clientCapabilities: (
    context: ServerContext,
  ) => ConfirmationClientCapabilities | undefined;
}): void {
  const configuredAuthorize = input.options.approvalApp?.authorize;
  const emitApprovalAudit = input.options.approvalApp?.onAudit ?? emitApprovalAppAudit;
  registerApprovalAppTools(input.server, {
    ...input.options.approvalApp,
    store: input.store,
    confirmationGate: input.confirmationGate,
    clientCapabilities: input.clientCapabilities,
    authorize: async (context, scope, runId) => {
      const principal = controlPlanePrincipal(context);
      const configuredAuthorization =
        configuredAuthorize === undefined
          ? undefined
          : await configuredAuthorize(context, scope, runId);
      if (principal !== undefined) {
        return {
          tokenId: configuredAuthorization?.tokenId ?? principal.tokenId,
          principal: Principal.parse(`token.${principal.tokenId}`),
          allowed:
            hasControlPlaneScope(principal, scope) &&
            (principal.runIds === undefined || principal.runIds.includes(runId)) &&
            (configuredAuthorization?.allowed ?? true),
        };
      }
      return (
        configuredAuthorization ?? {
          allowed: false,
          tokenId: Code.parse("unknown"),
          principal: "cli.control_plane",
        }
      );
    },
    revealRateLimiter:
      input.options.approvalApp?.revealRateLimiter ?? new ApprovalAppRevealRateLimiter(),
    onAudit: (audit) => {
      emitApprovalAudit(audit);
      (input.options.onAudit ?? emitControlPlaneAudit)(audit);
    },
    ...(input.options.operations?.resolveApproval === undefined
      ? {}
      : { resolveApproval: input.options.operations.resolveApproval }),
  });
}

/** Starts the same MCP server over stdio. */
export function startControlPlaneStdio(
  store: EventStore,
  options: ControlPlaneServerOptions = {},
): StdioServerHandle {
  const sharedOptions = withSharedControlPlaneState(store, options);
  return serveStdio(() => createControlPlaneServer(store, sharedOptions), { maxSubscriptions: 50 });
}

/** Starts an authenticated HTTP MCP endpoint with TLS, Host, Origin, scope, and rate checks. */
export function startControlPlaneHttp(
  store: EventStore,
  port: number,
  options: ControlPlaneServerOptions = {},
): Promise<ControlPlaneHttpHandle> {
  return startControlPlaneHttpTransport({
    store,
    port,
    options: { ...options, onAudit: options.onAudit ?? emitControlPlaneAudit },
    createMcpServer: createControlPlaneServer,
    withSharedState: withSharedControlPlaneState,
  });
}

function createRunSupervisor(options: ControlPlaneServerOptions): RunSupervisor {
  return new RunSupervisor({
    ...(options.maxConcurrentRuns === undefined
      ? {}
      : { maxConcurrentRuns: options.maxConcurrentRuns }),
    ...(options.runQueue === undefined ? {} : { queue: options.runQueue }),
    ...(options.operations?.resumeRun === undefined
      ? {}
      : { resumeRun: options.operations.resumeRun }),
  });
}

function withSharedControlPlaneState(
  store: EventStore,
  options: ControlPlaneServerOptions,
): ControlPlaneServerOptions {
  return {
    ...options,
    approvalHtml: options.approvalHtml ?? loadApprovalHtml(),
    approvalApp: {
      ...options.approvalApp,
      ...(options.approvalApp?.allowReveal === undefined &&
      options.controlPlane?.allowReveal === undefined
        ? {}
        : {
            allowReveal:
              options.approvalApp?.allowReveal ?? options.controlPlane?.allowReveal ?? false,
          }),
      revealRateLimiter:
        options.approvalApp?.revealRateLimiter ?? new ApprovalAppRevealRateLimiter(),
    },
    confirmationGate:
      options.confirmationGate ??
      new ConfirmationGate({
        ...options.confirmation,
        store,
        ...(options.isAppContext === undefined ? {} : { isAppContext: options.isAppContext }),
      }),
    runSupervisor: options.runSupervisor ?? createRunSupervisor(options),
  };
}

function requestClientCapabilities(
  context: ServerContext,
  server: McpServer,
): ConfirmationClientCapabilities | undefined {
  const envelope = z.record(z.string(), z.unknown()).safeParse(context.mcpReq.envelope);
  if (envelope.success && Object.hasOwn(envelope.data, CLIENT_CAPABILITIES_META_KEY)) {
    const capabilities = confirmationClientCapabilitiesSchema.safeParse(
      envelope.data[CLIENT_CAPABILITIES_META_KEY],
    );
    return capabilities.success ? capabilities.data : undefined;
  }
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- Legacy 2025-era requests carry capabilities only in initialize state.
  const legacyCapabilities = server.server.getClientCapabilities();
  const parsedCapabilities = confirmationClientCapabilitiesSchema.safeParse(legacyCapabilities);
  return parsedCapabilities.success ? parsedCapabilities.data : undefined;
}
