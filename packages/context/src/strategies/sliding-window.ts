// SPDX-License-Identifier: Apache-2.0
import { HarnessError, type Code, type Message } from "@rovinos/schemas";
import { ContextResultSchema, type ContextResult, type ContextStrategy } from "../types.js";
import { derivePlan, renderPlanMessage } from "../plan.js";
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

/** Optional cache-prefix preservation settings for sliding-window context. */
export interface SlidingWindowStrategyOptions {
  /** Drop groups in cache-aligned chunks instead of shifting the prefix one group at a time. */
  readonly cacheAware?: boolean;
  /** Number of groups to drop together when cacheAware is enabled. Defaults to 4. */
  readonly dropChunkGroups?: number;
}

/**
 * Keeps pinned groups and the newest contiguous window that fits the token budget.
 */
export class SlidingWindowStrategy implements ContextStrategy {
  readonly id: Code = "sliding_window";
  readonly version: Code;
  private readonly cacheAware: boolean;
  private readonly dropChunkGroups: number;

  /**
   * Creates a sliding window strategy.
   *
   * @param options - Optional cache-prefix preservation settings.
   */
  constructor(options: SlidingWindowStrategyOptions = {}) {
    this.cacheAware = options.cacheAware ?? false;
    this.dropChunkGroups = options.dropChunkGroups ?? 4;
    // Without cacheAware the window drops one group at a time and dropChunkGroups has no effect, so
    // the behavior (and version) is unchanged from v4; only cache-aware windows get a new version.
    this.version = this.cacheAware ? `v5_cache_aware_${String(this.dropChunkGroups)}` : "v4";
    if (!Number.isSafeInteger(this.dropChunkGroups) || this.dropChunkGroups < 1) {
      throw new RangeError("dropChunkGroups must be a positive integer.");
    }
  }

  /** {@inheritDoc ContextStrategy.build} */
  async build(input: Parameters<ContextStrategy["build"]>[0]): Promise<ContextResult> {
    const groups = eventsToTranscript(
      input.previousEventLogs === undefined
        ? input.events
        : [...input.previousEventLogs, input.events],
    );
    const pinnedGroups = groups.filter((group) => group.pinned);
    const plan = derivePlan(input.events);
    const planMessages = plan === undefined ? [] : [renderPlanMessage(plan)];
    const availableTokens = input.budget.maxTokens - input.budget.reserveOutputTokens;
    const pinnedMessages = [...pinnedGroups.flatMap((group) => group.messages), ...planMessages];
    const fullMessages = [...groups.flatMap((group) => group.messages), ...planMessages];
    const fullEstimate = input.counter.count(fullMessages, input.model);

    if (fullEstimate <= availableTokens) {
      return createResult({
        input,
        groups,
        retainedGroups: new Set(groups),
        messages: fullMessages,
        droppedGroups: 0,
        estimatedTokens: fullEstimate,
      });
    }

    const pinnedEstimate = input.counter.count(pinnedMessages, input.model);
    if (pinnedEstimate > availableTokens) {
      throw new ContextPinnedExceedsBudgetError();
    }

    return this.buildWindow({
      input,
      groups,
      plan,
      planMessages,
      availableTokens,
      pinnedEstimate,
    });
  }

  private buildWindow({
    input,
    groups,
    plan,
    planMessages,
    availableTokens,
    pinnedEstimate,
  }: {
    input: Parameters<ContextStrategy["build"]>[0];
    groups: ReturnType<typeof eventsToTranscript>;
    plan: ReturnType<typeof derivePlan>;
    planMessages: Message[];
    availableTokens: number;
    pinnedEstimate: number;
  }): Promise<ContextResult> {
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
    if (this.cacheAware && droppedGroups > 0) {
      const chunkedDroppedGroups = Math.min(
        nonPinnedGroups.length,
        Math.ceil(droppedGroups / this.dropChunkGroups) * this.dropChunkGroups,
      );
      dropOldestGroups(nonPinnedGroups, retainedGroups, chunkedDroppedGroups - droppedGroups);
      droppedGroups = chunkedDroppedGroups;
    }
    let messages = renderMessages(groups, retainedGroups, droppedGroups, planMessages);
    let estimatedTokens = input.counter.count(messages, input.model);

    while (estimatedTokens > availableTokens) {
      const removedGroups = dropOldestGroups(
        nonPinnedGroups,
        retainedGroups,
        this.cacheAware ? this.dropChunkGroups : 1,
      );
      if (removedGroups === 0) {
        if (droppedGroups > 0) {
          if (plan !== undefined) {
            throw new ContextPinnedExceedsBudgetError();
          }
          throw new ContextMarkerExceedsBudgetError();
        }
        throw new ContextPinnedExceedsBudgetError();
      }
      droppedGroups += removedGroups;
      messages = renderMessages(groups, retainedGroups, droppedGroups, planMessages);
      estimatedTokens = input.counter.count(messages, input.model);
    }

    return createResult({
      input,
      groups,
      retainedGroups,
      messages,
      droppedGroups,
      estimatedTokens,
    });
  }
}

function createResult({
  input,
  groups,
  retainedGroups,
  messages,
  droppedGroups,
  estimatedTokens,
}: {
  input: Parameters<ContextStrategy["build"]>[0];
  groups: ReturnType<typeof eventsToTranscript>;
  retainedGroups: ReadonlySet<(typeof groups)[number]>;
  messages: Message[];
  droppedGroups: number;
  estimatedTokens: number;
}): Promise<ContextResult> {
  return ContextResultSchema.parseAsync({
    messages,
    stablePrefixMessages: countStablePrefixMessages(groups, retainedGroups, droppedGroups),
    stats: {
      messageCount: messages.length,
      estimatedTokens,
      droppedGroups,
      compactedRanges: input.events.filter((event) => event.type === "context_compacted").length,
      offloadedResults: countOffloadedResults(messages),
    },
    pinnedSeqs: groups.filter((group) => group.pinned).flatMap((group) => group.seqs),
    retainedSeqs: groups
      .filter((group) => group.pinned || retainedGroups.has(group))
      .flatMap(({ runId, seqs }) => seqs.map((seq) => ({ runId, seq }))),
  });
}

function dropOldestGroups(
  groups: ReturnType<typeof eventsToTranscript>,
  retainedGroups: Set<(typeof groups)[number]>,
  count: number,
): number {
  if (count === 0) {
    return 0;
  }
  let removed = 0;
  for (const group of groups) {
    if (!retainedGroups.has(group)) {
      continue;
    }
    retainedGroups.delete(group);
    removed += 1;
    if (removed === count) {
      break;
    }
  }
  return removed;
}

function countStablePrefixMessages(
  groups: ReturnType<typeof eventsToTranscript>,
  retainedGroups: ReadonlySet<(typeof groups)[number]>,
  droppedGroups: number,
): number {
  const latestGroupIndex = groups.findLastIndex(
    (group) => !group.pinned && retainedGroups.has(group),
  );
  const prefixEnd = latestGroupIndex < 0 ? groups.length : latestGroupIndex;
  const messageCount = groups
    .slice(0, prefixEnd)
    .filter((group) => group.pinned || retainedGroups.has(group))
    .reduce((count, group) => count + group.messages.length, 0);
  const hasRetainedGroups = groups.some((group) => !group.pinned && retainedGroups.has(group));
  return messageCount + (droppedGroups > 0 && hasRetainedGroups ? 1 : 0);
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
  planMessages: readonly Message[],
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
  messages.push(...planMessages);
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
