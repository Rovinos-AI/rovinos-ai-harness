// SPDX-License-Identifier: Apache-2.0
import {
  ModelsConfigSchema,
  type SandboxConfigSchema,
  type Code,
  type ControlPlaneConfig,
  type Event,
  type PolicyConfig,
  type PiiConfig,
  type QuotaConfig,
  type RolesConfig,
  type Id,
  type JsonValue,
  type KeyProvider,
  type KeysConfig,
  type ModelsConfig,
  type RunConfig,
  type RunInput,
  type Principal,
  type SecretRef,
  type ServersConfig,
  type StoreConfig,
  type DeploymentConfig,
  type ElicitationConfig,
  type VaultConfig,
} from "@rovinos/schemas";
import type { z } from "zod";
import type { Context } from "@opentelemetry/api";
import type { SandboxBackend, WorkspaceSnapshotPort } from "@rovinos/sandbox";
import type { ProviderAdapter } from "@rovinos/models";
import type { McpConnectionDependencies } from "@rovinos/mcp";
import type { EventStore, RunQueue } from "@rovinos/store";
import type {
  AuditingVaultResolver,
  LocalKeyProvider,
  VaultResolver,
  VaultAdmin,
  VaultWriter,
} from "@rovinos/vault";
import type { PiiMessageSanitizer, Tokenizer } from "@rovinos/pii";
import type { WorkspacePort } from "@rovinos/context";
import type {
  ContextPort,
  IdGenerator,
  ModelPort,
  PolicyPort,
  RunContext,
  ToolPort,
} from "./ports.js";
import type { Clock } from "./recorder.js";
import type { HumanInputChannel } from "./human-input/channels.js";
import type { ShutdownProcessLike } from "./shutdown.js";
import type { RunLoopResult } from "./loop.js";
import type { CancelRunResult } from "./cancel.js";
import type { RunScopeRegistry } from "./subagent/scope.js";
import type { ApprovalDecision, ApprovalResolutionMetadata } from "./approvals.js";
import type { AppContentTokenize, RuntimeAppContent, RuntimeAppCallbacks } from "./runtime-apps.js";

/** Runtime dependencies that can be replaced by tests or embedding applications. */
export interface RuntimeOverrides {
  readonly store?: EventStore;
  /** Optional durable queue used for worker execution and automatic approval resumption. */
  readonly queue?: RunQueue;
  readonly dataDir?: string;
  /** Directory used to resolve role prompt and result-schema references. */
  readonly roleConfigDirectory?: string;
  /** Open existing storage without schema initialization or writes. */
  readonly readOnlyStore?: boolean;
  /** Use an in-memory vault explicitly, for tests that do not need persistence. */
  readonly transientVault?: boolean;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
  readonly model?: ModelPort;
  /** Replay-only: recorded model and tool port responses are tokenized; storage sanitization stays enabled. */
  readonly alreadyTokenized?: boolean;
  /** Provider adapters and secret resolution can be supplied by tests or embedders. */
  readonly providerAdapters?: readonly ProviderAdapter[];
  readonly secretResolver?: {
    resolve(ref: SecretRef, signal?: AbortSignal): Promise<{ reveal(): string }>;
  };
  /** Receives safe warnings raised during key-provider setup. */
  readonly onKeysWarning?: (code: "keys_ephemeral") => void;
  readonly tool?: ToolPort;
  /** Runtime-owned backend override, including its optional shutdown hook. */
  readonly sandboxBackend?: SandboxBackend;
  /** Composes tool adapters with the shared backend; `tool` takes precedence. */
  readonly createTool?: (backend: SandboxBackend) => ToolPort;
  /** Optional MCP transport factory for embedded runtimes and in-memory tests. */
  readonly mcpTransportFactory?: McpConnectionDependencies["createTransport"];
  /** Workspace used to persist offloaded tool results, including MCP binary outputs. */
  readonly workspace?: WorkspacePort;
  /** Policy evaluator replacing the policy document configured for the runtime. */
  readonly policy?: PolicyPort;
  readonly context?: ContextPort;
  /** Channels allowed to answer live MCP elicitation requests. */
  readonly inputChannels?: readonly HumanInputChannel[];
  /** Shared token-scope registry used by the runtime and its tool adapters. */
  readonly scopeRegistry?: RunScopeRegistry;
  readonly processLike?: ShutdownProcessLike;
  /** Flush the embedding telemetry SDK before final run-trip drains and runtime shutdown. */
  readonly flushTelemetry?: () => Promise<void>;
}

/** Runtime configuration required by the currently implemented run loop. */
export interface RuntimeConfig {
  readonly run: RunConfig;
  readonly deployment?: DeploymentConfig;
  readonly pii?: PiiConfig;
  readonly store?: StoreConfig;
  readonly vault?: VaultConfig;
  readonly models?: ModelsConfig;
  readonly roles?: RolesConfig;
  readonly policy?: PolicyConfig;
  readonly quotas?: readonly QuotaConfig[];
  readonly keys?: KeysConfig | undefined;
  readonly sandbox?: z.infer<typeof SandboxConfigSchema>;
  readonly servers?: ServersConfig;
  readonly elicitation?: ElicitationConfig;
  readonly controlPlane?: ControlPlaneConfig | undefined;
}

/** Optional cooperative cancellation and claim notification for a resumed run. */
export interface RuntimeResumeOptions {
  /** Additional signal composed with the runtime's cancellation and shutdown signals. */
  readonly signal?: AbortSignal;
  /** Called after the resume claim has been written durably. */
  readonly onClaimed?: () => void;
}

/** Run lifecycle handle returned once an execution has been scheduled. */
export interface RuntimeRunHandle {
  readonly runId: Id;
  readonly started: Promise<void>;
  readonly completion: Promise<RunLoopResult>;
}

/** Composed run-loop operations and their shared dependencies. */
export interface Runtime {
  readonly store: EventStore;
  /** Queue used to schedule worker jobs when one was configured by the embedder. */
  readonly queue?: RunQueue;
  /** Read-only resolver for audited vault access by runtime consumers. */
  readonly vault: AuditingVaultResolver;
  /** Key provider shared by encryption consumers in the composed runtime. */
  readonly keys: KeyProvider;
  /** Shared backend for sandbox-backed tool adapters. */
  readonly sandboxBackend: SandboxBackend;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  run(
    goal: JsonValue,
    options?: {
      readonly role?: Code;
      readonly requestedBy?: Principal;
      readonly replayOf?: Id;
      readonly parentRunId?: Id;
      readonly rootSpanParent?: Context;
    },
  ): Promise<RunLoopResult>;
  /** Starts a run and exposes when its initial events are durable and when execution settles. */
  start(
    goal: JsonValue,
    options?: {
      readonly role?: Code;
      readonly runId?: Id;
      readonly replayOf?: Id;
      readonly parentRunId?: Id;
      readonly rootSpanParent?: Context;
      readonly requestedBy?: Principal;
      readonly onProgress?: NonNullable<RunContext["onProgress"]>;
    },
  ): RuntimeRunHandle;
  /** Starts a follow-up run and exposes durable startup and eventual completion. */
  continueRun(
    runId: Id,
    input: RunInput,
    options?: { readonly requestedBy?: Principal },
  ): RuntimeRunHandle;
  resume(runId: Id, options?: RuntimeResumeOptions): Promise<RunLoopResult>;
  /** Requests durable cancellation and reports if the run was already terminal. */
  cancel(runId: Id): Promise<CancelRunResult>;
  /** Resolves a pending approval using the runtime's PII-aware tool port. */
  resolveApproval(
    runId: Id,
    approvalId: Id,
    decision: ApprovalDecision,
    options?: {
      readonly edits?: JsonValue;
      readonly metadata?: ApprovalResolutionMetadata;
    },
  ): Promise<Extract<Event, { type: "approval_resolved" }>>;
  /** Returns whether the folded state currently contains a pending approval. */
  hasPendingApproval(runId: Id): Promise<boolean>;
  /** Tokenizes app-originated JSON at the model-input boundary. */
  tokenizeAppContent: AppContentTokenize;
  /** Records tokenized app content with an explicit untrusted label. */
  onAppContent(content: RuntimeAppContent): Promise<void>;
  /** Suspends an app tool call using the run's durable approval and resume path. */
  onAppCallApproval: RuntimeAppCallbacks["onAppCallApproval"];
  close(): Promise<void>;
}

/** Owned writer/resolver handle closed with its runtime. */
export interface RuntimeVault extends VaultWriter, VaultResolver, VaultAdmin {
  close(): void | Promise<void>;
}

/** Resolved dependencies needed to assemble a running runtime. */
export interface RuntimeComposition {
  readonly config: RuntimeConfig;
  readonly overrides: RuntimeOverrides;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly store: EventStore;
  readonly keys: LocalKeyProvider;
  readonly sandboxBackend: SandboxBackend;
  readonly workspaceSnapshotter: WorkspaceSnapshotPort;
  readonly instanceHeartbeat?: { readonly signal: AbortSignal; close(): Promise<void> };
  readonly vault: RuntimeVault;
  readonly vaultResolver: AuditingVaultResolver;
  readonly pii:
    | {
        readonly config: PiiConfig;
        readonly tokenizer: Tokenizer;
        readonly resolver: AuditingVaultResolver;
        readonly messageSanitizer: PiiMessageSanitizer;
      }
    | undefined;
  readonly model: ModelPort;
  readonly tool: ToolPort;
  readonly closeToolPort?: () => Promise<void>;
  readonly policy: PolicyPort;
  readonly policyVersion: PolicyPort["version"];
  readonly context: ContextPort;
}

/** Applies model configuration defaults before gateway construction. */
export function parseRuntimeModelsConfig(config: ModelsConfig | undefined): ModelsConfig {
  return ModelsConfigSchema.parse(config ?? {});
}
