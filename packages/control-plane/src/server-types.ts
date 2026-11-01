// SPDX-License-Identifier: Apache-2.0
import type { ControlPlaneConfig, Id, Principal, RunStatus, Code } from "@rovinos/schemas";
import type { RunQueue } from "@rovinos/store";
import type { AuditingVaultResolver } from "@rovinos/vault";
import type { ServerContext } from "@modelcontextprotocol/server";
import type { ModelProgress } from "@rovinos/models";
import type { RunResourceUpdatesError } from "./resources/run-updates.js";
import type { ConfirmationGate, ConfirmationGateOptions } from "./confirmation-gate.js";
import type {
  ApprovalAppRevealRateLimiter,
  ApprovalAppScope,
  ApprovalAppAuthorization,
} from "./tools/approvals-app.js";
import type {
  ControlPlaneSecretResolver,
  ControlPlaneClock,
  ControlPlaneAuditHandler,
} from "./auth.js";
import type { RunSupervisor } from "./run-supervisor.js";
import type { ResolveApprovalOperation } from "./tools/approve.js";
import type { ResolveInputOperation } from "./tools/answer-input.js";
import type { ContinueRunInput, StartRunInput } from "./schemas.js";

/** Mutation operations supplied by the composed runtime. */
export interface ControlPlaneOperations {
  readonly startRun?: (
    input: StartRunInput & {
      readonly requestedBy: Principal;
      readonly allowedExistingRunIds?: readonly Id[];
      readonly onProgress?: (progress: ModelProgress) => void;
    },
  ) => Promise<{ readonly runId: Id; readonly status: RunStatus }>;
  readonly continueRun?: (
    runId: Id,
    input: Omit<ContinueRunInput, "runId"> & { readonly requestedBy: Principal },
  ) => Promise<{ readonly runId: Id; readonly status: RunStatus }>;
  readonly checkRunQuota?: (input: {
    readonly requestedBy: Principal;
    readonly role?: Code;
  }) => Promise<void>;
  readonly resumeRun?: (runId: Id, signal: AbortSignal, onClaimed: () => void) => Promise<unknown>;
  readonly cancelRun?: (runId: Id) => Promise<unknown>;
  readonly resolveApproval?: ResolveApprovalOperation;
  readonly resolveInput?: ResolveInputOperation;
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
  /** Built human-input MCP App HTML; injectable for in-memory server tests. */
  readonly inputHtml?: string;
  /** Built runs-console MCP App HTML; injectable for in-memory server tests. */
  readonly runsConsoleHtml?: string;
  /** Optional URL shown to text-only clients as an approval fallback. */
  readonly consoleUrl?: string;
  /** Publishes resource changes through the serving entry's subscription bus. */
  readonly onResourceUpdated?: (uri: string) => void;
  /** Defaults to true; HTTP transport owns one shared watch instead of one per session. */
  readonly subscribeRunUpdates?: boolean;
  /** Receives typed failures when live run watchers exceed their configured bound. */
  readonly onRunResourceUpdateError?: (error: RunResourceUpdatesError) => void;
}
