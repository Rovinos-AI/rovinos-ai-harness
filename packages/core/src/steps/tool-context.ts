// SPDX-License-Identifier: Apache-2.0
import type { Event, Id } from "@rovinos/schemas";
import type { ElicitationRetry } from "@rovinos/mcp";
import type { Checkpointer } from "../checkpoint.js";
import type { Clock, RunRecorder } from "../recorder.js";
import type { IdGenerator, RunContext, ToolPort } from "../ports.js";
import type { Tokenizer } from "@rovinos/pii";
import type { AuditingVaultResolver } from "@rovinos/vault";
import type { HumanInputChannel } from "../human-input/channels.js";
import { toolRunContext } from "./prepare-tool.js";
import { createMcpElicitationPort } from "./input-step.js";

interface ToolContextOptions {
  readonly recorder: RunRecorder;
  readonly clock: Clock;
  readonly tool: ToolPort;
  readonly runId: Id;
  readonly signal: AbortSignal;
  readonly depth?: number;
  readonly ids?: IdGenerator;
  readonly checkpointer?: Checkpointer;
  readonly history?: readonly Event[];
  readonly inputChannels?: readonly HumanInputChannel[];
  readonly tokenizer?: Pick<Tokenizer, "tokenizeJson">;
  readonly resolver?: AuditingVaultResolver;
}

/** Creates the run-scoped tool context and installs durable MRTR handling when resuming. */
export function createToolExecutionContext(
  options: ToolContextOptions,
  events: Event[],
  callId: Id,
  inputRetry?: ElicitationRetry,
): RunContext {
  const base = toolRunContext(
    {
      runId: options.runId,
      signal: options.signal,
      toolRegistry: options.tool,
      ...(options.depth === undefined ? {} : { depth: options.depth }),
    },
    options.recorder,
    events,
  );
  if (options.ids === undefined) {
    return base;
  }
  return {
    ...base,
    elicitation: createMcpElicitationPort({
      runId: options.runId,
      callId,
      clock: options.clock,
      events,
      history: options.history ?? [],
      ids: options.ids,
      recorder: options.recorder,
      checkpointer: options.checkpointer,
      ...(options.inputChannels === undefined ? {} : { inputChannels: options.inputChannels }),
      ...(options.tokenizer === undefined ? {} : { tokenizer: options.tokenizer }),
      ...(options.resolver === undefined ? {} : { resolver: options.resolver }),
    }),
    ...(inputRetry === undefined ? {} : { inputRetry }),
  };
}
