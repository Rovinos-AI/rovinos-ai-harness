// SPDX-License-Identifier: Apache-2.0
import { Code, Principal, type ControlPlaneConfig, type Id } from "@harness/schemas";
import type { EventStore, RunQueue } from "@harness/store";
import type { AuditingVaultResolver } from "@harness/vault";
import { CLIENT_CAPABILITIES_META_KEY, McpServer } from "@modelcontextprotocol/server";
import type { ServerContext } from "@modelcontextprotocol/server";
import { serveStdio, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { emitApprovalAppAudit, emitControlPlaneAudit } from "@harness/telemetry";
import {
  confirmationClientCapabilitiesSchema,
  ConfirmationGate,
  type ConfirmationClientCapabilities,
  type ConfirmationGateOptions,
} from "./confirmation-gate.js";
import { RunSupervisor } from "./run-supervisor.js";
import type { ResolveApprovalOperation } from "./tools/approve.js";
import { registerApproveTool } from "./tools/approve.js";
import { registerCancelRunTool } from "./tools/cancel-run.js";
import { registerDenyTool } from "./tools/deny.js";
import { registerGetRunTool } from "./tools/get-run.js";
import { registerListRunsTool } from "./tools/list-runs.js";
import { registerResumeRunTool } from "./tools/resume-run.js";
import {
  registerApprovalAppTools,
  ApprovalAppRevealRateLimiter,
  type ApprovalAppAuthorization,
  type ApprovalAppScope,
} from "./tools/approvals-app.js";
import { loadApprovalHtml, registerApprovalResource } from "./resources/approval.js";
import {
  controlPlanePrincipal,
  hasControlPlaneScope,
  type ControlPlaneAuditHandler,
  type ControlPlaneClock,
  type ControlPlaneSecretResolver,
} from "./auth.js";
import { startControlPlaneHttpTransport, type ControlPlaneHttpHandle } from "./http-server.js";
import { toolDefinitions, toolScope } from "./tool-definitions.js";

export type { ControlPlaneHttpHandle };

const MCP_APP_EXTENSION = "io.modelcontextprotocol/ui";
const MCP_APP_MIME = "text/html;profile=mcp-app";

/** Mutation operations supplied by the composed runtime. */
export interface ControlPlaneOperations {
  readonly resumeRun?: (runId: Id, signal: AbortSignal, onClaimed: () => void) => Promise<unknown>;
  readonly cancelRun?: (runId: Id) => Promise<unknown>;
  readonly resolveApproval?: ResolveApprovalOperation;
}

/** Optional dependencies for control-plane mutation and confirmation tools. */
export interface ControlPlaneServerOptions {
  /** Parsed server authentication, network binding, and reveal configuration. */
  readonly controlPlane?: ControlPlaneConfig;
  /** Secret resolver used for control-plane bearer tokens and TLS material. */
  readonly secretResolver?: ControlPlaneSecretResolver;
  /** Clock used by the per-token HTTP request limiter. */
  readonly clock?: ControlPlaneClock;
  /** Metadata-only audit sink; defaults to the sanctioned telemetry logger. */
  readonly onAudit?: ControlPlaneAuditHandler;
  readonly operations?: ControlPlaneOperations;
  /** Durable queue used for asynchronous run resumption, when configured. */
  readonly runQueue?: RunQueue;
  readonly maxConcurrentRuns?: number;
  readonly runSupervisor?: RunSupervisor;
  readonly confirmationGate?: ConfirmationGate;
  readonly confirmation?: ConfirmationGateOptions;
  /** Must reflect trusted host-side app provenance, not client-controlled request fields. */
  readonly isAppContext?: (context: ServerContext, toolName: string) => boolean;
  readonly approvalApp?: {
    readonly authorize?: (
      context: ServerContext,
      scope: ApprovalAppScope,
      runId: Id,
    ) => Promise<ApprovalAppAuthorization> | ApprovalAppAuthorization;
    readonly vaultResolver?: AuditingVaultResolver;
    readonly allowReveal?: boolean;
    readonly revealRateLimiter?: ApprovalAppRevealRateLimiter;
    readonly now?: () => number;
    readonly onAudit?: (audit: {
      readonly tokenId: Code;
      readonly tool: Code;
      readonly outcome: Code;
      readonly count: number;
    }) => void;
  };
  readonly approvalHtml?: string;
}

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
  server.server.registerCapabilities({ tools: {} });
  const clientCapabilities = (context: ServerContext): ConfirmationClientCapabilities | undefined =>
    requestClientCapabilities(context, server);
  registerListRunsTool(server, store, options.onAudit);
  registerGetRunTool(server, store, options.onAudit);
  registerApprovalResource(server, options.approvalHtml ?? loadApprovalHtml());
  registerConfiguredApprovalTools({
    server,
    store,
    options,
    confirmationGate,
    clientCapabilities,
  });
  const supervisor = options.runSupervisor ?? createRunSupervisor(options);
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
    const supportsApps = supportsMcpApps(requestClientCapabilities(context, server));
    const principal = controlPlanePrincipal(context);
    return {
      tools: definitions.filter(
        (tool) =>
          (tool._meta?.ui === undefined || supportsApps) &&
          (principal === undefined || hasControlPlaneScope(principal, toolScope(tool.name))),
      ),
    };
  });
  return server;
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
  return serveStdio(() => createControlPlaneServer(store, sharedOptions));
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

function supportsMcpApps(capabilities: ConfirmationClientCapabilities | undefined): boolean {
  const extension = z
    .object({ mimeTypes: z.array(z.string()) })
    .loose()
    .safeParse(capabilities?.extensions?.[MCP_APP_EXTENSION]);
  return extension.success && extension.data.mimeTypes.includes(MCP_APP_MIME);
}

function requestClientCapabilities(
  context: ServerContext,
  server: McpServer,
): ConfirmationClientCapabilities | undefined {
  const envelope = z.record(z.string(), z.unknown()).safeParse(context.mcpReq.envelope);
  if (envelope.success) {
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
