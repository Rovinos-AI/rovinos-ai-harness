// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { Code, HarnessError, Sha256Hex, type Event, type Id, type JsonValue } from "@harness/schemas";
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

function rootEvents(resolved: ResolvedRun): readonly Event[] {
  return resolved.runs.find(({ runId }) => runId === resolved.rootRunId)?.events ?? [];
}

/** Serves recorded tool results and never invokes the current registry's executor. */
export class ReplayToolPort implements ToolPort {
  readonly alreadyTokenized = true;
  private readonly intents = new Map<Id, Extract<Event, { type: "tool_intent" }>>();
  private readonly results = new Map<Id, Extract<Event, { type: "tool_result" }>>();

  /**
   * @param resolved - Resolved event logs containing tool intents and results.
   * @param registry - Optional read-only registry for timeout and tool-schema metadata.
   */
  constructor(
    resolved: ResolvedRun,
    private readonly registry?: Pick<ToolPort, "describe" | "getToolSpecs" | "validateInputSchema">,
  ) {
    for (const event of rootEvents(resolved)) {
      if (event.type === "tool_intent") {
        this.intents.set(event.callId, event);
      } else if (event.type === "tool_result") {
        this.results.set(event.callId, event);
      }
    }
  }

  /** Returns recorded idempotency with timeout and schema metadata from the optional registry. */
  describe(toolId: Code, args?: JsonValue): ToolDescription | undefined {
    const requestedHash = args === undefined ? undefined : hashArgs(args);
    const intent = [...this.intents.values()].find(
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

  /** Forwards model-visible specifications without forwarding execution. */
  getToolSpecs(): ReturnType<NonNullable<ToolPort["getToolSpecs"]>> {
    return this.registry?.getToolSpecs?.() ?? [];
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
  async execute(call: ModelToolCall, _context: RunContext): Promise<ToolExecutionResult> {
    const intent = this.intents.get(call.callId);
    const result = this.results.get(call.callId);
    if (intent === undefined || result === undefined) {
      throw new ReplayMissingResultError(intent?.seq);
    }
    if (hashArgs(call.args) !== intent.argsHash) {
      throw new ReplayDivergenceError(intent.seq);
    }
    const outcome = result.outcome === "ok" ? "ok" : "error";
    const errorCode =
      result.errorCode ??
      (result.outcome === "timeout" ? Code.parse("tool_timeout") : Code.parse("tool_failed"));
    return {
      outcome,
      result: result.result,
      ...(outcome === "error" ? { errorCode } : {}),
    };
  }
}

/** Raised if a replay path attempts to invoke a live human or sandbox capability. */
export class ReplayExternalAccessError extends HarnessError {
  readonly code = "replay_external_access";

  constructor() {
    super("Replay cannot access external tools, models, or humans.");
  }
}
