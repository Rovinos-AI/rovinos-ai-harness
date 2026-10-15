// SPDX-License-Identifier: Apache-2.0
import {
  HarnessError,
  JsonValue,
  ResolveRequest,
  ResolveResponse,
  RevealRequest,
  RevealResponse,
} from "@harness/schemas";
import type { Code, Id } from "@harness/schemas";
import type { EventStore } from "@harness/store";
import type { AuditingVaultResolver } from "@harness/vault";
import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from "@modelcontextprotocol/node";
import {
  CLIENT_CAPABILITIES_META_KEY,
  createMcpHandler,
  McpServer,
} from "@modelcontextprotocol/server";
import type { ServerContext, Tool } from "@modelcontextprotocol/server";
import { serveStdio, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import { createServer, type Server } from "node:http";
import { z } from "zod";
import {
  confirmationClientCapabilitiesSchema,
  ConfirmationGate,
  type ConfirmationClientCapabilities,
  type ConfirmationGateOptions,
} from "./confirmation-gate.js";
import { RunSupervisor } from "./run-supervisor.js";
import {
  approveInputSchema,
  controlPlaneHttpPortSchema,
  decisionOutputSchema,
  denyInputSchema,
  getRunInputSchema,
  getRunOutputSchema,
  listRunsInputSchema,
  listRunsOutputSchema,
  resumeRunOutputSchema,
  runLifecycleInputSchema,
} from "./schemas.js";
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
import { emitApprovalAppAudit } from "@harness/telemetry";
import { loadApprovalHtml, registerApprovalResource } from "./resources/approval.js";

const HTTP_HOST = "127.0.0.1";
const HTTP_PATH = "/mcp";
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
  readonly operations?: ControlPlaneOperations;
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

class ControlPlaneListenError extends HarnessError {
  override readonly code = "control_plane_listen_failed";

  constructor() {
    super("The control-plane HTTP listener failed.");
  }
}

/** A running loopback HTTP endpoint. */
export interface ControlPlaneHttpHandle {
  /** MCP endpoint URL. */
  endpoint: string;
  /** Closes the listener and active connections. */
  close(): Promise<void>;
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
  registerListRunsTool(server, store);
  registerGetRunTool(server, store);
  registerApprovalResource(server, options.approvalHtml ?? loadApprovalHtml());
  registerConfiguredApprovalTools({
    server,
    store,
    options,
    confirmationGate,
    clientCapabilities,
  });
  const supervisor = options.runSupervisor ?? createRunSupervisor(options);
  registerApproveTool(server, {
    store,
    confirmationGate,
    ...(options.operations?.resolveApproval === undefined
      ? {}
      : { resolveApproval: options.operations.resolveApproval }),
    clientCapabilities,
  });
  registerDenyTool(server, {
    store,
    confirmationGate,
    ...(options.operations?.resolveApproval === undefined
      ? {}
      : { resolveApproval: options.operations.resolveApproval }),
    clientCapabilities,
  });
  registerResumeRunTool(server, { confirmationGate, supervisor, clientCapabilities });
  registerCancelRunTool(server, {
    confirmationGate,
    supervisor,
    ...(options.operations?.cancelRun === undefined
      ? {}
      : { cancelRun: options.operations.cancelRun }),
    clientCapabilities,
  });
  const definitions = toolDefinitions();
  server.server.setRequestHandler("tools/list", (_request, context) => {
    const supportsApps = supportsMcpApps(requestClientCapabilities(context, server));
    return {
      tools: definitions.filter((tool) => tool._meta?.ui === undefined || supportsApps),
    };
  });
  return server;
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
  registerApprovalAppTools(input.server, {
    ...input.options.approvalApp,
    store: input.store,
    confirmationGate: input.confirmationGate,
    clientCapabilities: input.clientCapabilities,
    revealRateLimiter:
      input.options.approvalApp?.revealRateLimiter ?? new ApprovalAppRevealRateLimiter(),
    onAudit: input.options.approvalApp?.onAudit ?? emitApprovalAppAudit,
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

/** Starts a loopback-only stateless HTTP MCP endpoint with Host and Origin checks. */
export async function startControlPlaneHttp(
  store: EventStore,
  port: number,
  options: ControlPlaneServerOptions = {},
): Promise<ControlPlaneHttpHandle> {
  const checkedPort = controlPlaneHttpPortSchema.parse(port);
  const sharedOptions = withSharedControlPlaneState(store, options);
  const handler = createMcpHandler(() => createControlPlaneServer(store, sharedOptions));
  const requestHandler = toNodeHandler(handler);
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  const server: Server = createServer((request, response) => {
    if ((request.url ?? "").split("?", 1)[0] !== HTTP_PATH) {
      response.writeHead(404).end();
      return;
    }

    if (!validateHost(request, response) || !validateOrigin(request, response)) {
      return;
    }
    void requestHandler(
      {
        method: request.method ?? "GET",
        url: request.url ?? "/",
        headers: request.headers,
        [Symbol.asyncIterator]: () => request[Symbol.asyncIterator](),
      },
      response,
    ).catch(() => {
      if (!response.headersSent) {
        response
          .writeHead(500, { "content-type": "text/plain; charset=utf-8" })
          .end("control_plane_request_failed");
      } else if (!response.writableEnded) {
        response.end();
      }
    });
  });
  await listen(server, checkedPort);
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new ControlPlaneListenError();
  }
  return {
    endpoint: `http://${HTTP_HOST}:${String(address.port)}${HTTP_PATH}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error !== undefined) {
            reject(new ControlPlaneListenError());
            return;
          }
          resolve();
        });
        server.closeAllConnections();
      }),
  };
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (): void => {
      server.off("error", onError);
      reject(new ControlPlaneListenError());
    };
    server.once("error", onError);
    server.listen(port, HTTP_HOST, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

function createRunSupervisor(options: ControlPlaneServerOptions): RunSupervisor {
  return new RunSupervisor({
    ...(options.maxConcurrentRuns === undefined
      ? {}
      : { maxConcurrentRuns: options.maxConcurrentRuns }),
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

function toolDefinitions(): Tool[] {
  return [
    {
      name: "list_runs",
      description: "List run status and metadata counts.",
      inputSchema: objectInputSchema(listRunsInputSchema),
      outputSchema: z.toJSONSchema(listRunsOutputSchema),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "get_run",
      description: "Get run status, usage, approvals, and recent safe event metadata.",
      inputSchema: objectInputSchema(getRunInputSchema),
      outputSchema: z.toJSONSchema(getRunOutputSchema),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "approve",
      description: "Approve a pending approval without resuming its run.",
      inputSchema: objectInputSchema(approveInputSchema),
      outputSchema: z.toJSONSchema(decisionOutputSchema),
      annotations: { idempotentHint: false, openWorldHint: false },
      _meta: { ui: { visibility: ["app"] } },
    },
    {
      name: "harness.approvals.resolve",
      description: "Resolve a pending approval from its human review view.",
      inputSchema: objectInputSchema(ResolveRequest),
      outputSchema: z.toJSONSchema(ResolveResponse),
      annotations: { openWorldHint: false },
      _meta: { ui: { visibility: ["app"] } },
    },
    {
      name: "harness.approvals.reveal",
      description: "Reveal selected approval argument values after authorization.",
      inputSchema: objectInputSchema(RevealRequest),
      outputSchema: z.toJSONSchema(RevealResponse),
      annotations: { openWorldHint: false },
      _meta: { ui: { visibility: ["app"] } },
    },
    {
      name: "deny",
      description: "Deny a pending approval without resuming its run.",
      inputSchema: objectInputSchema(denyInputSchema),
      outputSchema: z.toJSONSchema(decisionOutputSchema),
      annotations: { idempotentHint: true, openWorldHint: false },
      _meta: { ui: { visibility: ["app"] } },
    },
    {
      name: "resume_run",
      description: "Resume a run asynchronously.",
      inputSchema: objectInputSchema(runLifecycleInputSchema),
      outputSchema: z.toJSONSchema(resumeRunOutputSchema),
      annotations: { openWorldHint: false },
    },
    {
      name: "cancel_run",
      description: "Request cancellation of a run.",
      inputSchema: objectInputSchema(runLifecycleInputSchema),
      outputSchema: z.toJSONSchema(decisionOutputSchema),
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
  ];
}

function objectInputSchema(schema: z.ZodType): Tool["inputSchema"] {
  return z
    .object({
      type: z.literal("object"),
      properties: z.record(z.string(), JsonValue).optional(),
      required: z.array(z.string()).optional(),
    })
    .loose()
    .parse(z.toJSONSchema(schema));
}
