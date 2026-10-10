// SPDX-License-Identifier: Apache-2.0
import { HarnessError, type Code, type Message } from "@harness/schemas";
import { ContextResultSchema, type ContextResult, type ContextStrategy } from "../types.js";
import { eventsToTranscript } from "../transcript.js";

class ContextPinnedExceedsBudgetError extends HarnessError {
  override readonly code = "context_pinned_exceeds_budget";

  constructor() {
    super("Pinned context groups exceed the available token budget.");
  }
}

class ContextMarkerExceedsBudgetError extends HarnessError {
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

    if (input.counter.count(pinnedMessages, input.model) > availableTokens) {
      throw new ContextPinnedExceedsBudgetError();
    }

    const nonPinnedGroups = groups.filter((group) => !group.pinned);
    const retainedGroups = new Set<(typeof nonPinnedGroups)[number]>();
    let remainingGroups = nonPinnedGroups.length;

    for (const group of [...nonPinnedGroups].reverse()) {
      remainingGroups -= 1;
      retainedGroups.add(group);
      const candidateMessages = renderMessages(groups, retainedGroups, remainingGroups);
      if (input.counter.count(candidateMessages, input.model) <= availableTokens) {
        continue;
      }
      retainedGroups.delete(group);
      break;
    }

    const droppedGroups = nonPinnedGroups.length - retainedGroups.size;
    const messages = renderMessages(groups, retainedGroups, droppedGroups);
    const estimatedTokens = input.counter.count(messages, input.model);
    if (estimatedTokens > availableTokens) {
      if (droppedGroups > 0) {
        throw new ContextMarkerExceedsBudgetError();
      }
      throw new ContextPinnedExceedsBudgetError();
    }

    const result = await ContextResultSchema.parseAsync({
      messages,
      stats: {
        messageCount: messages.length,
        estimatedTokens,
        droppedGroups,
        compactedRanges: input.events.filter((event) => event.type === "context_compacted").length,
        offloadedResults: countOffloadedResults(messages),
      },
      pinnedSeqs: pinnedGroups.flatMap((group) => group.seqs),
    });
    return result;
  }
}

function renderMessages(
  groups: ReturnType<typeof eventsToTranscript>,
  retainedGroups: ReadonlySet<(typeof groups)[number]>,
  droppedGroups: number,
): Message[] {
  const marker: Message[] =
    droppedGroups === 0
      ? []
      : [
          {
            role: "user",
            parts: [{ type: "text", text: `[${String(droppedGroups)} earlier steps omitted]` }],
          },
        ];
  return [
    ...marker,
    ...groups
      .filter((group) => group.pinned || retainedGroups.has(group))
      .flatMap((group) => group.messages),
  ];
}

function countOffloadedResults(messages: readonly Message[]): number {
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
