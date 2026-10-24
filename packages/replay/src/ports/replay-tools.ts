// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import {
  Code,
  HarnessError,
  Sha256Hex,
  type Event,
  type Id,
  type JsonValue,
} from "@harness/schemas";
import type {
  ModelToolCall,
  RunContext,
  ToolDescription,
  ToolExecutionResult,
  ToolPort,
} from "@harness/core";
import type { ResolvedRun } from "../resolve.js";
import { ReplayDivergenceError, ReplayMissingResultError } from "./replay-model.js";

const DEFAULT_TIMEOUT_MS = 60_000;

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] ?? null)}`)
    .join(",")}}`;
}

function hashArgs(args: JsonValue): string {
  return Sha256Hex.parse(createHash("sha256").update(canonicalJson(args)).digest("hex"));
}

/** Serves recorded tool results and never invokes the current registry's executor. */
export class ReplayToolPort implements ToolPort {
  readonly alreadyTokenized = true;
  readonly getToolSpecs?: NonNullable<ToolPort["getToolSpecs"]>;
  private readonly rootReplayRunId: Id;
  private readonly originalRootRunId: Id;
  private readonly runs = new Map<
    Id,
    {
      readonly intents: Map<Id, Extract<Event, { type: "tool_intent" }>>;
      readonly results: Map<Id, Extract<Event, { type: "tool_result" }>>;
    }
  >();

  /**
   * @param resolved - Resolved event logs containing tool intents and results.
   * @param registry - Optional read-only registry for timeout and tool-schema metadata.
   */
  constructor(
    resolved: ResolvedRun,
    private readonly registry?: Pick<ToolPort, "describe" | "getToolSpecs" | "validateInputSchema">,
    replayRunId = resolved.rootRunId,
  ) {
    this.rootReplayRunId = replayRunId;
    this.originalRootRunId = resolved.rootRunId;
    if (registry?.getToolSpecs !== undefined) {
      this.getToolSpecs = () => registry.getToolSpecs?.() ?? [];
    }
    for (const run of resolved.runs) {
      const intents = new Map<Id, Extract<Event, { type: "tool_intent" }>>();
      const results = new Map<Id, Extract<Event, { type: "tool_result" }>>();
      for (const event of run.events) {
        if (event.type === "tool_intent") {
          intents.set(event.callId, event);
        } else if (event.type === "tool_result") {
          results.set(event.callId, event);
        }
      }
      this.runs.set(run.runId, { intents, results });
    }
  }

  /** Returns recorded idempotency with timeout and schema metadata from the optional registry. */
  describe(toolId: Code, args?: JsonValue): ToolDescription | undefined {
    const requestedHash = args === undefined ? undefined : hashArgs(args);
    const intent = [...this.runs.values()].flatMap(({ intents }) => [...intents.values()]).find(
      (candidate) =>
        candidate.toolId === toolId &&
        (requestedHash === undefined || candidate.argsHash === requestedHash),
    );
    if (intent === undefined) {
      return undefined;
    }
    const registered = this.registry?.describe(toolId, args);
    return {
      idempotent: intent.idempotent,
      timeoutMs: registered?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      ...(registered?.longRunning === undefined ? {} : { longRunning: registered.longRunning }),
      ...(registered?.inputSchema === undefined ? {} : { inputSchema: registered.inputSchema }),
    };
  }

  /** Validates against the current registry without executing the tool. */
  validateInputSchema(
    toolId: Code,
    args: JsonValue,
    schema: JsonValue,
    context: RunContext,
  ): Promise<boolean> {
    return (
      this.registry?.validateInputSchema?.(toolId, args, schema, context) ?? Promise.resolve(true)
    );
  }

  /** Preserves already-tokenized model arguments without calling the live tool preparer. */
  prepare(call: ModelToolCall): Promise<ModelToolCall> {
    return Promise.resolve(call);
  }

  /** Returns the recorded result or fails closed on missing or divergent input. */
  execute(call: ModelToolCall, context: RunContext): Promise<ToolExecutionResult> {
    const runId =
      context.runId === this.rootReplayRunId ? this.originalRootRunId : context.runId;
    const run = this.runs.get(runId);
    const intent = run?.intents.get(call.callId);
    const result = run?.results.get(call.callId);
    if (intent === undefined || result === undefined) {
      return Promise.reject(new ReplayMissingResultError(intent?.seq));
    }
    if (hashArgs(call.args) !== intent.argsHash) {
      return Promise.reject(new ReplayDivergenceError(intent.seq, "tool_args_hash_mismatch"));
    }
    const outcome = result.outcome === "ok" ? "ok" : "error";
    const errorCode =
      result.errorCode ??
      (result.outcome === "timeout" ? Code.parse("tool_timeout") : Code.parse("tool_failed"));
    return Promise.resolve({
      outcome,
      result: result.result,
      ...(outcome === "error" ? { errorCode } : {}),
    });
  }
}

/** Raised if a replay path attempts to invoke a live human or sandbox capability. */
export class ReplayExternalAccessError extends HarnessError {
  readonly code = "replay_external_access";

  constructor() {
    super("Replay cannot access external tools, models, or humans.");
  }
}
