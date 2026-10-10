// SPDX-License-Identifier: Apache-2.0
import {
  ModelsConfigSchema,
  type RolesConfig,
  type Id,
  type JsonValue,
  type ModelsConfig,
  type RunConfig,
  type SecretRef,
} from "@harness/schemas";
import type { ProviderAdapter } from "@harness/models";
import type { EventStore } from "@harness/store";
import type { ContextPort, IdGenerator, ModelPort, ToolPort } from "./ports.js";
import type { Clock } from "./recorder.js";
import type { ShutdownProcessLike } from "./shutdown.js";
import type { RunLoopResult } from "./loop.js";
import type { CancelRunResult } from "./cancel.js";

/** Runtime dependencies that can be replaced by tests or embedding applications. */
export interface RuntimeOverrides {
  readonly store?: EventStore;
  readonly dataDir?: string;
  /** Directory used to resolve role prompt and result-schema references. */
  readonly roleConfigDirectory?: string;
  /** Open existing SQLite storage without schema initialization or writes. */
  readonly readOnlyStore?: boolean;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
  readonly model?: ModelPort;
  /** Provider adapters and secret resolution can be supplied by tests or embedders. */
  readonly providerAdapters?: readonly ProviderAdapter[];
  readonly secretResolver?: {
    resolve(ref: SecretRef): Promise<{ reveal(): string }>;
  };
  readonly tool?: ToolPort;
  readonly context?: ContextPort;
  readonly processLike?: ShutdownProcessLike;
}

/** Runtime configuration required by the currently implemented run loop. */
export interface RuntimeConfig {
  readonly run: RunConfig;
  readonly models?: ModelsConfig;
  readonly roles?: RolesConfig;
}

/** Composed run-loop operations and their shared dependencies. */
export interface Runtime {
  readonly store: EventStore;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  run(goal: JsonValue): Promise<RunLoopResult>;
  resume(runId: Id): Promise<RunLoopResult>;
  /** Requests durable cancellation and reports if the run was already terminal. */
  cancel(runId: Id): Promise<CancelRunResult>;
  close(): Promise<void>;
}

/** Resolved dependencies needed to assemble a running runtime. */
export interface RuntimeComposition {
  readonly config: RuntimeConfig;
  readonly overrides: RuntimeOverrides;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly store: EventStore;
  readonly model: ModelPort;
  readonly tool: ToolPort;
  readonly context: ContextPort;
}

/** Applies model configuration defaults before gateway construction. */
export function parseRuntimeModelsConfig(config: ModelsConfig | undefined): ModelsConfig {
  return ModelsConfigSchema.parse(config ?? {});
}
