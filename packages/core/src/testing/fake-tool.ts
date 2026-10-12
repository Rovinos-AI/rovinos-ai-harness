// SPDX-License-Identifier: Apache-2.0
import type { Code } from "@harness/schemas";
import type {
  ModelToolCall,
  RunContext,
  ToolDescription,
  ToolExecutionResult,
  ToolPort,
} from "../ports.js";

/** Scripted behavior and metadata for a fake tool. */
export interface FakeToolDefinition extends ToolDescription {
  readonly execute: (call: ModelToolCall, context: RunContext) => Promise<ToolExecutionResult>;
}

/** A tool invocation captured by the fake. */
export interface CapturedToolCall {
  readonly call: ModelToolCall;
  readonly context: RunContext;
}

/** Error raised if a fake tool is directly executed without a script. */
export class FakeToolScriptMissingError extends Error {
  /** Stable failure code. */
  readonly code = "fake_tool_script_missing";

  /** Creates an error for a missing fake tool script. */
  constructor() {
    super("The fake tool has no script.");
    this.name = "FakeToolScriptMissingError";
  }
}

/** Fake tool implementation that records calls and runs configured scripts. */
export class FakeToolPort implements ToolPort {
  readonly calls: CapturedToolCall[] = [];

  /**
   * Creates a fake tool port from tool metadata and execution handlers.
   *
   * @param definitions - Tool definitions indexed by tool ID.
   */
  constructor(private readonly definitions: ReadonlyMap<Code, FakeToolDefinition> = new Map()) {}

  /** {@inheritDoc ToolPort.describe} */
  describe(toolId: Code): ToolDescription | undefined {
    const definition = this.definitions.get(toolId);
    if (definition === undefined) {
      return undefined;
    }
    return {
      idempotent: definition.idempotent,
      timeoutMs: definition.timeoutMs,
      ...(definition.longRunning === undefined ? {} : { longRunning: definition.longRunning }),
      ...(definition.inputSchema === undefined ? {} : { inputSchema: definition.inputSchema }),
    };
  }

  /** {@inheritDoc ToolPort.execute} */
  execute(call: ModelToolCall, context: RunContext): Promise<ToolExecutionResult> {
    const definition = this.definitions.get(call.toolId);
    if (definition === undefined) {
      return Promise.reject(new FakeToolScriptMissingError());
    }
    this.calls.push({ call, context });
    return definition.execute(call, context);
  }
}
