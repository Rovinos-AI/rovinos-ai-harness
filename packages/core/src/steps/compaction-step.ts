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
  type Part,
} from "@rovinos/schemas";
import {
  eventsToTranscript,
  type ContextBudget,
  type SummarizingStrategy,
  type TokenCounter,
  type TranscriptGroup,
} from "@rovinos/context";
import type { IdGenerator, ModelPort, RunContext, Summarizer } from "../ports.js";
import type { RunRecorder } from "../recorder.js";
import type { UsageLedgerDelta } from "@rovinos/store";
import { COMPACTION_SPAN } from "../spans.js";

const DEFAULT_KEEP_RECENT_GROUPS = 6;
const SUMMARIZATION_INSTRUCTION =
  "Summarize the transcript while preserving the goal, decisions made, open tasks, key facts and identifiers, tokens verbatim (for example <EMAIL_1>), tool outcomes, and errors encountered. Do not invent facts or expand tokens.";

function summarizerPart(part: Part): Record<string, unknown> | undefined {
  switch (part.type) {
    case "text":
      return { type: part.type, text: part.text };
    case "tool_call":
      return { type: part.type, toolId: part.toolId, args: part.args };
    case "tool_result":
      return {
        type: part.type,
        outcome: part.isError ? "error" : "ok",
        result: part.result,
      };
    case "opaque":
      return undefined;
  }
}

function isAbortOrDeadlineError(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") {
    return true;
  }
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  return error.code === "deadline_exceeded" || error.code === "run_aborted";
}

async function summarizeOrSkip(options: {
  readonly summarizer: Summarizer;
  readonly groups: readonly TranscriptGroup[];
  readonly goal: string;
  readonly signal?: AbortSignal;
}): Promise<Awaited<ReturnType<Summarizer["summarize"]>> | undefined> {
  options.signal?.throwIfAborted();
  try {
    const summary = await options.summarizer.summarize({
      groups: options.groups,
      goal: options.goal,
    });
    options.signal?.throwIfAborted();
    return summary;
  } catch (error) {
    if (options.signal?.aborted === true || isAbortOrDeadlineError(error)) {
      throw error;
    }
    return undefined;
  }
}

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
                        const summarized = summarizerPart(part);
                        return summarized === undefined ? [] : [summarized];
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
  readonly usageUpdatesForCost?: (costMicros: number | undefined) => readonly UsageLedgerDelta[];
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
  const previousCompaction =
    previousCompactedTo === undefined
      ? undefined
      : [...events]
          .reverse()
          .find(
            (event): event is Extract<Event, { type: "context_compacted" }> =>
              event.type === "context_compacted" && event.toSeq === previousCompactedTo,
          );
  const previousSummary =
    previousCompaction === undefined
      ? undefined
      : transcript.find(
          (group) =>
            group.pinned &&
            group.seqs.length === 1 &&
            group.seqs[0] === previousCompaction.fromSeq &&
            group.messages.some((message) =>
              message.parts.some(
                (part) => part.type === "text" && part.text.startsWith("Summary of earlier work: "),
              ),
            ),
        );
  const eligible = transcript.filter((group) => {
    return !group.pinned && group.seqs.every((seq) => seq >= startSeq);
  });
  const groups = eligible.slice(0, Math.max(0, eligible.length - keepRecentGroups));
  if (groups.length === 0) {
    return undefined;
  }
  const seqs = groups.flatMap((group) => group.seqs);
  return {
    groups: [...(previousSummary === undefined ? [] : [previousSummary]), ...groups],
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
  const summary = await summarizeOrSkip({
    summarizer: options.summarizer,
    groups: source.groups,
    goal: options.goal,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (summary === undefined) {
    return undefined;
  }
  return options.recorder.withStepSpan(COMPACTION_SPAN, {}, async () => {
    const tokenizedSummary = await options.sanitizeSummary(summary.text);
    return options.recorder.record(
      {
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
      },
      options.usageUpdatesForCost?.(summary.usage.costMicros),
    );
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
  readonly usageUpdatesForCost?: (costMicros: number | undefined) => readonly UsageLedgerDelta[];
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
    ...(options.usageUpdatesForCost === undefined
      ? {}
      : { usageUpdatesForCost: options.usageUpdatesForCost }),
    ...(compaction.keepRecentGroups === undefined
      ? {}
      : { keepRecentGroups: compaction.keepRecentGroups }),
  });
  if (event !== undefined) {
    options.events.push(event);
  }
}
