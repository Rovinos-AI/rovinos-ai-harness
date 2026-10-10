// SPDX-License-Identifier: Apache-2.0
import {
  HarnessError,
  JsonValue,
  ModelRefSchema,
  ModelRequestSchema,
  type Event,
  type Id,
  type ModelRef,
  type ModelUsage,
} from "@harness/schemas";
import {
  eventsToTranscript,
  type ContextBudget,
  type SummarizingStrategy,
  type TokenCounter,
  type TranscriptGroup,
} from "@harness/context";
import type { IdGenerator, ModelPort, RunContext, Summarizer } from "../ports.js";
import type { RunRecorder } from "../recorder.js";
import { COMPACTION_SPAN } from "../spans.js";

const DEFAULT_KEEP_RECENT_GROUPS = 6;
const SUMMARIZATION_INSTRUCTION =
  "Summarize the transcript while preserving the goal, decisions made, open tasks, key facts and identifiers, tokens verbatim (for example <EMAIL_1>), tool outcomes, and errors encountered. Do not invent facts or expand tokens.";

/** Error raised when a summarizer produces no textual content. */
export class SummarizerResponseError extends HarnessError {
  override readonly code = "summarizer_response_empty";

  constructor() {
    super("The summarizer returned no text.");
  }
}

/** ModelPort-backed summarizer that always requests the summarizer model role. */
export class ModelPortSummarizer implements Summarizer {
  private readonly modelRef: ModelRef;

  /**
   * @param model - Model port routed to the summarizer role.
   * @param ids - Run-scoped request ID source.
   * @param modelRef - Fallback model reference when no role route is configured.
   * @param context - Run context supplied to the model boundary.
   */
  constructor(
    private readonly model: ModelPort,
    private readonly ids: IdGenerator,
    modelRef: ModelRef,
    private readonly context: RunContext,
  ) {
    this.modelRef = ModelRefSchema.parse(modelRef);
  }

  /** {@inheritDoc Summarizer.summarize} */
  async summarize(input: {
    readonly groups: readonly TranscriptGroup[];
    readonly goal: string;
  }): Promise<{ readonly text: string; readonly usage: ModelUsage }> {
    const response = await this.model.complete(
      ModelRequestSchema.parse({
        requestId: this.ids.next(),
        model: this.modelRef,
        role: "summarizer",
        messages: [
          { role: "system", parts: [{ type: "text", text: SUMMARIZATION_INSTRUCTION }] },
          {
            role: "user",
            parts: [
              {
                type: "text",
                text: `Goal:\n${input.goal}\n\nTranscript groups:\n${JSON.stringify(
                  input.groups.map((group) => ({
                    seqs: group.seqs,
                    messages: group.messages.map((message) => ({
                      role: message.role,
                      parts: message.parts.flatMap((part) => {
                        switch (part.type) {
                          case "text":
                            return [{ type: part.type, text: part.text }];
                          case "tool_call":
                            return [{ type: part.type, toolId: part.toolId, args: part.args }];
                          case "tool_result":
                            return [
                              {
                                type: part.type,
                                outcome: part.isError ? "error" : "ok",
                                result: part.result,
                              },
                            ];
                          case "opaque":
                            return [];
                        }
                      }),
                    })),
                  })),
                )}`,
              },
            ],
          },
        ],
      }),
      this.context,
    );
    const text = response.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    if (text.trim().length === 0) {
      throw new SummarizerResponseError();
    }
    return { text, usage: response.usage };
  }
}

/** Inputs to the side-effecting transcript compaction step. */
export interface CompactionStepOptions {
  readonly recorder: RunRecorder;
  readonly events: readonly Event[];
  readonly strategy: SummarizingStrategy;
  readonly summarizer: Summarizer;
  readonly budget: ContextBudget;
  readonly counter: TokenCounter;
  readonly goal: string;
  readonly sanitizeSummary: (text: string) => Promise<string>;
  readonly keepRecentGroups?: number;
  readonly signal?: AbortSignal;
}

function sourceGroups(
  events: readonly Event[],
  keepRecentGroups: number,
):
  | { readonly groups: TranscriptGroup[]; readonly fromSeq: number; readonly toSeq: number }
  | undefined {
  // New source ranges never repeat old source; replay still handles nested compaction events.
  const previousCompactedTo = events.reduce<number | undefined>(
    (latest, event) =>
      event.type === "context_compacted" ? Math.max(latest ?? -1, event.toSeq) : latest,
    undefined,
  );
  const startSeq = previousCompactedTo === undefined ? 0 : previousCompactedTo + 1;
  const transcript = eventsToTranscript(events);
  const eligible = transcript.filter(
    (group) => !group.pinned && group.seqs.every((seq) => seq >= startSeq),
  );
  if (
    previousCompactedTo !== undefined &&
    !eligible.some((group) => group.seqs.some((seq) => seq > startSeq))
  ) {
    return undefined;
  }
  const groups = eligible.slice(0, Math.max(0, eligible.length - keepRecentGroups));
  if (groups.length === 0) {
    return undefined;
  }
  const seqs = groups.flatMap((group) => group.seqs);
  return {
    groups,
    fromSeq: previousCompactedTo === undefined ? Math.min(...seqs) : startSeq,
    toSeq: Math.max(...seqs),
  };
}

/**
 * Summarizes the oldest eligible groups and records exactly one durable compaction event.
 *
 * @param options - Recorder, transcript, strategy, summarizer, and budget dependencies.
 * @returns The recorded event, or undefined when the transcript has no eligible range.
 */
export async function compactionStep(options: CompactionStepOptions): Promise<Event | undefined> {
  const keepRecentGroups = options.keepRecentGroups ?? DEFAULT_KEEP_RECENT_GROUPS;
  if (!Number.isSafeInteger(keepRecentGroups) || keepRecentGroups < 0) {
    throw new RangeError("keepRecentGroups must be a nonnegative integer.");
  }
  if (!options.strategy.needsCompaction(options.events, options.budget, options.counter)) {
    return undefined;
  }
  const source = sourceGroups(options.events, keepRecentGroups);
  if (source === undefined) {
    return undefined;
  }
  options.signal?.throwIfAborted();
  let summary: Awaited<ReturnType<Summarizer["summarize"]>>;
  try {
    summary = await options.summarizer.summarize({
      groups: source.groups,
      goal: options.goal,
    });
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (
      options.signal?.aborted === true ||
      (error instanceof Error && error.name === "AbortError") ||
      code === "deadline_exceeded" ||
      code === "run_aborted"
    ) {
      throw error;
    }
    return undefined;
  }
  options.signal?.throwIfAborted();
  return options.recorder.withStepSpan(COMPACTION_SPAN, {}, async () => {
    const tokenizedSummary = await options.sanitizeSummary(summary.text);
    return options.recorder.record({
      type: "context_compacted",
      v: 1,
      fromSeq: source.fromSeq,
      toSeq: source.toSeq,
      strategy: options.strategy.id,
      strategyVersion: options.strategy.version,
      summary: JsonValue.parse(tokenizedSummary),
      inputTokens: summary.usage.inputTokens,
      outputTokens: summary.usage.outputTokens,
      ...(summary.usage.costMicros === undefined ? {} : { costMicros: summary.usage.costMicros }),
    });
  });
}

/** Runtime configuration accepted by the run loop for pre-request compaction. */
export type CompactionRuntimeOptions = Omit<
  Pick<
    CompactionStepOptions,
    "strategy" | "budget" | "counter" | "sanitizeSummary" | "keepRecentGroups"
  >,
  "summarizer"
> & { readonly summarizer?: Summarizer };

/** Runs configured compaction against the current run history before a model request. */
export async function compactBeforeModelCall(options: {
  readonly recorder: RunRecorder;
  readonly events: Event[];
  readonly compaction: CompactionRuntimeOptions | undefined;
  readonly model: ModelPort;
  readonly ids: IdGenerator;
  readonly runId: Id;
  readonly signal: AbortSignal;
  readonly deadlineTs?: number;
  readonly modelRef: ModelRef;
  readonly goal: JsonValue;
}): Promise<void> {
  const compaction = options.compaction;
  if (compaction === undefined) {
    return;
  }
  const summarizer =
    compaction.summarizer ??
    new ModelPortSummarizer(options.model, options.ids, options.modelRef, {
      runId: options.runId,
      signal: options.signal,
      ...(options.deadlineTs === undefined ? {} : { deadlineTs: options.deadlineTs }),
    });
  const event = await compactionStep({
    recorder: options.recorder,
    events: options.events,
    strategy: compaction.strategy,
    summarizer,
    budget: compaction.budget,
    counter: compaction.counter,
    goal: typeof options.goal === "string" ? options.goal : JSON.stringify(options.goal),
    sanitizeSummary: compaction.sanitizeSummary,
    signal: options.signal,
    ...(compaction.keepRecentGroups === undefined
      ? {}
      : { keepRecentGroups: compaction.keepRecentGroups }),
  });
  if (event !== undefined) {
    options.events.push(event);
  }
}
