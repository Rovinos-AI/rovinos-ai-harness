// SPDX-License-Identifier: Apache-2.0
import {
  ModelsConfigSchema,
  type PolicyConfig,
  type PiiConfig,
  type RolesConfig,
  type Id,
  type Event,
  type JsonValue,
  type KeyProvider,
  type KeysConfig,
  type ModelsConfig,
  type RunConfig,
  type RunInput,
  type SecretRef,
  type ServersConfig,
  type StoreConfig,
  type VaultConfig,
} from "@harness/schemas";
import type { ProviderAdapter } from "@harness/models";
import type { McpConnectionDependencies } from "@harness/mcp";
import type { EventStore } from "@harness/store";
import type {
  AuditingVaultResolver,
  LocalKeyProvider,
  VaultResolver,
  VaultAdmin,
  VaultWriter,
} from "@harness/vault";
import type { Tokenizer } from "@harness/pii";
import type { ContextPort, IdGenerator, ModelPort, PolicyPort, ToolPort } from "./ports.js";
import type { Clock } from "./recorder.js";
import type { ShutdownProcessLike } from "./shutdown.js";
import type { RunLoopResult } from "./loop.js";
import type { CancelRunResult } from "./cancel.js";
import type { ApprovalDecision } from "./approvals.js";
import type { RunScopeRegistry } from "./subagent/scope.js";

/** Runtime dependencies that can be replaced by tests or embedding applications. */
export interface RuntimeOverrides {
  readonly store?: EventStore;
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
  /** Provider adapters and secret resolution can be supplied by tests or embedders. */
  readonly providerAdapters?: readonly ProviderAdapter[];
  readonly secretResolver?: {
    resolve(ref: SecretRef): Promise<{ reveal(): string }>;
  };
  /** Receives safe warnings raised during key-provider setup. */
  readonly onKeysWarning?: (code: "keys_ephemeral") => void;
  readonly tool?: ToolPort;
  /** Optional MCP transport factory for embedded runtimes and in-memory tests. */
  readonly mcpTransportFactory?: McpConnectionDependencies["createTransport"];
  /** Policy evaluator replacing the policy document configured for the runtime. */
  readonly policy?: PolicyPort;
  readonly context?: ContextPort;
  /** Shared token-scope registry used by the runtime and its tool adapters. */
  readonly scopeRegistry?: RunScopeRegistry;
  readonly processLike?: ShutdownProcessLike;
  /** Flush the embedding telemetry SDK before final run-trip drains and runtime shutdown. */
  readonly flushTelemetry?: () => Promise<void>;
}

/** Runtime configuration required by the currently implemented run loop. */
export interface RuntimeConfig {
  readonly run: RunConfig;
  readonly pii?: PiiConfig;
  readonly store?: StoreConfig;
  readonly vault?: VaultConfig;
  readonly models?: ModelsConfig;
  readonly roles?: RolesConfig;
  readonly policy?: PolicyConfig;
  readonly keys?: KeysConfig | undefined;
  readonly servers?: ServersConfig;
}

/** Optional cooperative cancellation and claim notification for a resumed run. */
export interface RuntimeResumeOptions {
  /** Additional signal composed with the runtime's cancellation and shutdown signals. */
  readonly signal?: AbortSignal;
  /** Called after the resume claim has been written durably. */
  readonly onClaimed?: () => void;
}

/** Composed run-loop operations and their shared dependencies. */
export interface Runtime {
  readonly store: EventStore;
  /** Read-only resolver for audited vault access by runtime consumers. */
  readonly vault: AuditingVaultResolver;
  /** Key provider shared by encryption consumers in the composed runtime. */
  readonly keys: KeyProvider;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  run(goal: JsonValue): Promise<RunLoopResult>;
  /** Starts a follow-up run from an eligible terminal run. */
  continueRun(runId: Id, input: RunInput): Promise<RunLoopResult>;
  resume(runId: Id, options?: RuntimeResumeOptions): Promise<RunLoopResult>;
  /** Requests durable cancellation and reports if the run was already terminal. */
  cancel(runId: Id): Promise<CancelRunResult>;
  /**
   * Resolves a pending approval using the runtime's PII-aware tool port.
   *
   * @param runId - Run containing the approval.
   * @param approvalId - Pending approval identifier.
   * @param decision - Human approval decision.
   * @param edits - Replacement arguments for an edit decision.
   * @returns The durable approval resolution event.
   */
  resolveApproval(
    runId: Id,
    approvalId: Id,
    decision: ApprovalDecision,
    edits?: JsonValue,
  ): Promise<Extract<Event, { type: "approval_resolved" }>>;
  close(): Promise<void>;
}

/** Owned writer/resolver handle closed with its runtime. */
export interface RuntimeVault extends VaultWriter, VaultResolver, VaultAdmin {
  close(): void;
}

/** Resolved dependencies needed to assemble a running runtime. */
export interface RuntimeComposition {
  readonly config: RuntimeConfig;
  readonly overrides: RuntimeOverrides;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly store: EventStore;
  readonly keys: LocalKeyProvider;
  readonly vault: RuntimeVault;
  readonly vaultResolver: AuditingVaultResolver;
  readonly pii:
    | {
        readonly config: PiiConfig;
        readonly tokenizer: Tokenizer;
        readonly resolver: AuditingVaultResolver;
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
