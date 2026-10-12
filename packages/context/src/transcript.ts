// SPDX-License-Identifier: Apache-2.0
import type { Event, JsonValue, Message } from "@harness/schemas";
import { TranscriptSchema, type TranscriptGroup } from "./types.js";

function inputText(input: JsonValue): string {
  return typeof input === "string" ? input : JSON.stringify(input);
}

function summaryText(summary: JsonValue): string {
  return typeof summary === "string" ? summary : JSON.stringify(summary);
}

function toolResultMessage(event: Extract<Event, { type: "tool_result" }>): Message {
  return {
    role: "tool",
    parts: [
      {
        type: "tool_result",
        callId: event.callId,
        result: event.result,
        isError: event.outcome !== "ok",
      },
    ],
  };
}

function removeCompactedGroups(
  groups: TranscriptGroup[],
  groupsByCallId: Map<string, TranscriptGroup>,
  range: {
    readonly summaryGroups: Set<TranscriptGroup>;
    readonly summaryRanges: Map<TranscriptGroup, number>;
    readonly fromSeq: number;
    readonly toSeq: number;
  },
): void {
  const { summaryGroups, summaryRanges, fromSeq, toSeq } = range;
  const removedGroups = new Set<TranscriptGroup>();
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index];
    if (group === undefined) {
      continue;
    }
    const sourceOverlaps = group.seqs.some((seq) => seq >= fromSeq && seq <= toSeq);
    const priorSummarySuperseded =
      summaryGroups.has(group) && summaryRanges.get(group) === fromSeq - 1;
    if (!sourceOverlaps && !priorSummarySuperseded) {
      continue;
    }
    if (group.pinned && !summaryGroups.has(group)) {
      continue;
    }
    groups.splice(index, 1);
    removedGroups.add(group);
    summaryGroups.delete(group);
    summaryRanges.delete(group);
  }
  for (const [callId, group] of groupsByCallId) {
    if (removedGroups.has(group)) {
      groupsByCallId.delete(callId);
    }
  }
}

function transcriptForRun(
  events: readonly Event[],
  newestInput: Extract<Event, { type: "run_input" }> | undefined,
): TranscriptGroup[] {
  const groups: TranscriptGroup[] = [];
  const groupsByCallId = new Map<string, TranscriptGroup>();
  const summaryGroups = new Set<TranscriptGroup>();
  const summaryRanges = new Map<TranscriptGroup, number>();

  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    if (event.type === "run_input") {
      const group: TranscriptGroup = {
        seqs: [event.seq],
        messages: [{ role: "user", parts: [{ type: "text", text: inputText(event.input) }] }],
        pinned: newestInput === undefined || event === newestInput,
      };
      groups.push(group);
    } else if (event.type === "model_response") {
      const group: TranscriptGroup = {
        seqs: [event.seq],
        messages: [{ role: "assistant", parts: event.content }],
        pinned: false,
      };
      groups.push(group);
      for (const part of event.content) {
        if (part.type === "tool_call") {
          groupsByCallId.set(part.callId, group);
        }
      }
    } else if (event.type === "tool_result") {
      const group = groupsByCallId.get(event.callId);
      if (group !== undefined) {
        group.seqs.push(event.seq);
        group.messages.push(toolResultMessage(event));
        groupsByCallId.delete(event.callId);
      }
    } else if (event.type === "context_compacted") {
      removeCompactedGroups(groups, groupsByCallId, {
        summaryGroups,
        summaryRanges,
        fromSeq: event.fromSeq,
        toSeq: event.toSeq,
      });
      const summaryGroup: TranscriptGroup = {
        seqs: [event.fromSeq],
        messages: [
          {
            role: "user",
            parts: [
              {
                type: "text",
                text: `Summary of earlier work: ${summaryText(event.summary)}`,
              },
            ],
          },
        ],
        pinned: true,
      };
      groups.push(summaryGroup);
      summaryGroups.add(summaryGroup);
      summaryRanges.set(summaryGroup, event.toSeq);
    }
  }

  const unansweredGroups = new Set(groupsByCallId.values());
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index];
    if (group !== undefined && unansweredGroups.has(group)) {
      groups.splice(index, 1);
    }
  }

  return groups.sort((left, right) => (left.seqs[0] ?? 0) - (right.seqs[0] ?? 0));
}

function isEventLogChain(
  eventsOrLogs: readonly Event[] | readonly (readonly Event[])[],
): eventsOrLogs is readonly (readonly Event[])[] {
  const first = eventsOrLogs[0];
  return first !== undefined && Array.isArray(first);
}

/**
 * Reconstructs atomic transcript groups from one run or an oldest-first continuation chain.
 * Orphan tool results and assistant groups with unanswered tool calls are omitted so providers
 * never receive an invalid tool turn; pending calls are handled by run resumption.
 *
 * @param eventsOrLogs - Validated events, or ordered per-run logs from oldest to newest.
 * @returns Transcript groups in run-chain and sequence order.
 */
export function eventsToTranscript(
  eventsOrLogs: readonly Event[] | readonly (readonly Event[])[],
): TranscriptGroup[] {
  const first = eventsOrLogs[0];
  let logs: readonly (readonly Event[])[] = [];
  if (first !== undefined) {
    logs = isEventLogChain(eventsOrLogs) ? eventsOrLogs : [eventsOrLogs];
  }
  let newestInput: Extract<Event, { type: "run_input" }> | undefined;
  for (const events of logs) {
    let newestInputInRun: Extract<Event, { type: "run_input" }> | undefined;
    for (const event of events) {
      if (
        event.type === "run_input" &&
        (newestInputInRun === undefined || event.seq > newestInputInRun.seq)
      ) {
        newestInputInRun = event;
      }
    }
    newestInput = newestInputInRun ?? newestInput;
  }
  const pinnedInput = logs.length > 1 ? newestInput : undefined;
  const reconstructed = logs.map((events) => transcriptForRun(events, pinnedInput));
  return TranscriptSchema.parse(reconstructed.flat());
}
