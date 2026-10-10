// SPDX-License-Identifier: Apache-2.0
import { HarnessError, type Code, type Message } from "@harness/schemas";
import { ContextResultSchema, type ContextResult, type ContextStrategy } from "../types.js";
import { eventsToTranscript } from "../transcript.js";

/** Indicates that pinned transcript groups alone exceed the available token budget. */
export class ContextPinnedExceedsBudgetError extends HarnessError {
  override readonly code = "context_pinned_exceeds_budget";

  constructor() {
    super("Pinned context groups exceed the available token budget.");
  }
}

/** Indicates that pinned context and the required omission marker exceed the budget. */
export class ContextMarkerExceedsBudgetError extends HarnessError {
  override readonly code = "context_marker_exceeds_budget";

  constructor() {
    super("The omission marker and pinned context exceed the available token budget.");
  }
}

/**
 * Keeps pinned groups and the newest contiguous window that fits the token budget.
 */
export class SlidingWindowStrategy implements ContextStrategy {
  readonly id: Code = "sliding_window";
  readonly version: Code = "v1";

  /** {@inheritDoc ContextStrategy.build} */
  async build(input: Parameters<ContextStrategy["build"]>[0]): Promise<ContextResult> {
    const groups = eventsToTranscript(input.events);
    const pinnedGroups = groups.filter((group) => group.pinned);
    const availableTokens = input.budget.maxTokens - input.budget.reserveOutputTokens;
    const pinnedMessages = pinnedGroups.flatMap((group) => group.messages);
    const fullMessages = groups.flatMap((group) => group.messages);
    const fullEstimate = input.counter.count(fullMessages, input.model);

    if (fullEstimate <= availableTokens) {
      return createResult({
        input,
        groups,
        messages: fullMessages,
        droppedGroups: 0,
        estimatedTokens: fullEstimate,
      });
    }

    const pinnedEstimate = input.counter.count(pinnedMessages, input.model);
    if (pinnedEstimate > availableTokens) {
      throw new ContextPinnedExceedsBudgetError();
    }

    const nonPinnedGroups = groups.filter((group) => !group.pinned);
    const retainedGroups = new Set<(typeof nonPinnedGroups)[number]>();
    let retainedEstimate = 0;

    for (const group of [...nonPinnedGroups].reverse()) {
      const groupEstimate = input.counter.count(group.messages, input.model);
      const droppedGroups = nonPinnedGroups.length - retainedGroups.size - 1;
      const markerEstimate =
        droppedGroups === 0 ? 0 : input.counter.count(createMarker(droppedGroups), input.model);
      if (pinnedEstimate + retainedEstimate + groupEstimate + markerEstimate > availableTokens) {
        break;
      }
      retainedGroups.add(group);
      retainedEstimate += groupEstimate;
    }

    let droppedGroups = nonPinnedGroups.length - retainedGroups.size;
    let messages = renderMessages(groups, retainedGroups, droppedGroups);
    let estimatedTokens = input.counter.count(messages, input.model);

    while (estimatedTokens > availableTokens) {
      const oldestRetainedGroup = nonPinnedGroups.find((group) => retainedGroups.has(group));
      if (oldestRetainedGroup === undefined) {
        if (droppedGroups > 0) {
          throw new ContextMarkerExceedsBudgetError();
        }
        throw new ContextPinnedExceedsBudgetError();
      }
      retainedGroups.delete(oldestRetainedGroup);
      droppedGroups += 1;
      messages = renderMessages(groups, retainedGroups, droppedGroups);
      estimatedTokens = input.counter.count(messages, input.model);
    }

    return createResult({ input, groups, messages, droppedGroups, estimatedTokens });
  }
}

function createResult({
  input,
  groups,
  messages,
  droppedGroups,
  estimatedTokens,
}: {
  input: Parameters<ContextStrategy["build"]>[0];
  groups: ReturnType<typeof eventsToTranscript>;
  messages: Message[];
  droppedGroups: number;
  estimatedTokens: number;
}): Promise<ContextResult> {
  return ContextResultSchema.parseAsync({
    messages,
    stats: {
      messageCount: messages.length,
      estimatedTokens,
      droppedGroups,
      compactedRanges: input.events.filter((event) => event.type === "context_compacted").length,
      offloadedResults: countOffloadedResults(messages),
    },
    pinnedSeqs: groups.filter((group) => group.pinned).flatMap((group) => group.seqs),
  });
}

function createMarker(droppedGroups: number): Message[] {
  return [
    {
      role: "user",
      parts: [{ type: "text", text: `[${String(droppedGroups)} earlier steps omitted]` }],
    },
  ];
}

function renderMessages(
  groups: ReturnType<typeof eventsToTranscript>,
  retainedGroups: ReadonlySet<(typeof groups)[number]>,
  droppedGroups: number,
): Message[] {
  let markerInserted = false;
  const messages: Message[] = [];
  for (const group of groups) {
    if (!group.pinned && retainedGroups.has(group) && !markerInserted && droppedGroups > 0) {
      messages.push(...createMarker(droppedGroups));
      markerInserted = true;
    }
    if (group.pinned || retainedGroups.has(group)) {
      messages.push(...group.messages);
    }
  }
  if (!markerInserted && droppedGroups > 0) {
    messages.push(...createMarker(droppedGroups));
  }
  return messages;
}

function countOffloadedResults(messages: readonly Message[]): number {
  // TODO(15.4): Replace the shared `$offloaded` check with OffloadedStub.safeParse.
  return messages.reduce(
    (count, message) =>
      count +
      message.parts.filter(
        (part) =>
          part.type === "tool_result" &&
          typeof part.result === "object" &&
          part.result !== null &&
          !Array.isArray(part.result) &&
          Object.hasOwn(part.result, "$offloaded"),
      ).length,
    0,
  );
}
