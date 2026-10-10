// SPDX-License-Identifier: Apache-2.0
import type { Code } from "@harness/schemas";
import { OffloadedStub } from "../offload.js";
import { ContextResultSchema, type ContextResult, type ContextStrategy } from "../types.js";
import { eventsToTranscript } from "../transcript.js";

/**
 * Keeps every reconstructed transcript group without applying a token limit.
 */
export class NaiveStrategy implements ContextStrategy {
  readonly id: Code = "naive";
  readonly version: Code = "v2";

  /** {@inheritDoc ContextStrategy.build} */
  async build(input: Parameters<ContextStrategy["build"]>[0]): Promise<ContextResult> {
    const groups = eventsToTranscript(input.events);
    const messages = groups.flatMap((group) => group.messages);
    const offloadedResults = messages.reduce(
      (count, message) =>
        count +
        message.parts.filter(
          (part) => part.type === "tool_result" && OffloadedStub.safeParse(part.result).success,
        ).length,
      0,
    );
    return ContextResultSchema.parseAsync({
      messages,
      stats: {
        messageCount: messages.length,
        estimatedTokens: input.counter.count(messages, input.model),
        droppedGroups: 0,
        compactedRanges: input.events.filter((event) => event.type === "context_compacted").length,
        offloadedResults,
      },
      pinnedSeqs: groups.filter((group) => group.pinned).flatMap((group) => group.seqs),
    });
  }
}
