// SPDX-License-Identifier: Apache-2.0
import { createRuntime } from "@rovinos/core";
import type { PolicyPort, Runtime, RuntimeConfig, ToolPort } from "@rovinos/core";
import { PiiConfigSchema, VaultConfigSchema } from "@rovinos/schemas";
import { InMemoryEventStore } from "@rovinos/store";
import type { SandboxBackend } from "@rovinos/sandbox";
import { z } from "zod";
import type { Id } from "@rovinos/schemas";
import { ResolvedRunSchema } from "./resolve.js";
import type { ResolvedRun } from "./resolve.js";
import { ReplayClock } from "./ports/replay-clock.js";
import { ReplayHuman } from "./ports/replay-human.js";
import { ReplayIdGenerator } from "./ports/replay-ids.js";
import { ReplayModelPort } from "./ports/replay-model.js";
import { ReplayExternalAccessError, ReplayToolPort } from "./ports/replay-tools.js";

/** Metadata-only diagnostics collected while constructing and using a replay runtime. */
export const ReplayRuntimeReportSchema = z
  .object({
    diagnostics: z.array(z.literal("replay_ids_exhausted")),
  })
  .strict();

/** Inferred metadata-only report produced by the replay runtime. */
export type ReplayRuntimeReport = z.infer<typeof ReplayRuntimeReportSchema>;

/** Runtime and deterministic human port operating on isolated replay storage. */
export interface ReplayRuntime {
  readonly runtime: Runtime;
  readonly human: ReplayHuman;
  readonly report: ReplayRuntimeReport;
}

/** Optional current policy and read-only registry data used by the replay runtime. */
export interface BuildReplayRuntimeOptions {
  readonly toolRegistry?: Pick<ToolPort, "describe" | "getToolSpecs" | "validateInputSchema">;
  readonly policy?: PolicyPort;
  readonly replayRunId?: Id;
  readonly sourceRunId?: Id;
}

function rootEvents(resolved: ResolvedRun) {
  return resolved.runs.find(({ runId }) => runId === resolved.rootRunId)?.events ?? [];
}

/**
 * Builds a runtime that can only read recorded responses and writes to a fresh store and vault.
 *
 * @param input - A validated resolved event log, current runtime configuration, and optional
 *   read-only tool metadata.
 * @returns An isolated runtime, a recorded approval resolver, and metadata-only diagnostics.
 */
export async function buildReplayRuntime(
  input: ResolvedRun,
  config: RuntimeConfig,
  options: BuildReplayRuntimeOptions = {},
): Promise<ReplayRuntime> {
  const resolved = ResolvedRunSchema.parse(input);
  const sourceRunId = options.sourceRunId ?? resolved.rootRunId;
  const source = resolved.runs.find(({ runId }) => runId === sourceRunId);
  const events = source?.events ?? rootEvents(resolved);
  const clock = new ReplayClock(events);
  const diagnostics: "replay_ids_exhausted"[] = [];
  const idEvents =
    options.replayRunId === undefined
      ? events
      : events.filter((event) => event.type !== "run_created");
  const ids = new ReplayIdGenerator(idEvents, sourceRunId, () => {
    if (!diagnostics.includes("replay_ids_exhausted")) {
      diagnostics.push("replay_ids_exhausted");
    }
  });
  const tool = new ReplayToolPort(resolved, options.toolRegistry, options.replayRunId, sourceRunId);
  const sandbox: SandboxBackend = {
    exec: () => Promise.reject(new ReplayExternalAccessError()),
  };
  const replayConfig: RuntimeConfig = {
    run: config.run,
    pii: PiiConfigSchema.parse({ ...config.pii, enabled: true }),
    vault: VaultConfigSchema.parse({ backend: "sqlite" }),
    ...(config.roles === undefined ? {} : { roles: config.roles }),
    ...(config.policy === undefined ? {} : { policy: config.policy }),
    ...(config.quotas === undefined ? {} : { quotas: config.quotas }),
  };
  const runtime = await createRuntime(replayConfig, {
    alreadyTokenized: true,
    clock,
    ids,
    model: new ReplayModelPort(resolved, {
      ids,
      clock,
      ...(options.replayRunId === undefined ? {} : { replayRunId: options.replayRunId }),
      sourceRunId,
    }),
    sandboxBackend: sandbox,
    store: new InMemoryEventStore(),
    tool,
    transientVault: true,
    ...(options.policy === undefined ? {} : { policy: options.policy }),
  });
  const report = {
    get diagnostics() {
      return ReplayRuntimeReportSchema.parse({ diagnostics: [...diagnostics] }).diagnostics;
    },
  };
  return { runtime, human: new ReplayHuman(resolved), report };
}
