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
  summaryGroups: Set<TranscriptGroup>,
  fromSeq: number,
  toSeq: number,
): void {
  const removedGroups = new Set<TranscriptGroup>();
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index];
    if (group?.seqs.some((seq) => seq >= fromSeq && seq <= toSeq) === true) {
      if (group.pinned && !summaryGroups.has(group)) {
        continue;
      }
      groups.splice(index, 1);
      removedGroups.add(group);
      summaryGroups.delete(group);
    }
  }
  for (const [callId, group] of groupsByCallId) {
    if (removedGroups.has(group)) {
      groupsByCallId.delete(callId);
    }
  }
}

/**
 * Reconstructs ordered, atomic transcript groups from durable run events.
 * Orphan tool results and assistant groups with unanswered tool calls are omitted so providers
 * never receive an invalid tool turn; pending calls are handled by run resumption.
 *
 * @param events - Validated events from one run, in any sequence order.
 * @returns Transcript groups ordered by their earliest sequence.
 */
export function eventsToTranscript(events: readonly Event[]): TranscriptGroup[] {
  const groups: TranscriptGroup[] = [];
  const groupsByCallId = new Map<string, TranscriptGroup>();
  const summaryGroups = new Set<TranscriptGroup>();

  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    if (event.type === "run_input") {
      groups.push({
        seqs: [event.seq],
        messages: [{ role: "user", parts: [{ type: "text", text: inputText(event.input) }] }],
        pinned: true,
      });
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
      removeCompactedGroups(groups, groupsByCallId, summaryGroups, event.fromSeq, event.toSeq);
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
        // Summaries remain available to budgeted strategies as durable context.
        pinned: true,
      };
      groups.push(summaryGroup);
      summaryGroups.add(summaryGroup);
    }
  }

  const unansweredGroups = new Set(groupsByCallId.values());
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index];
    if (group !== undefined && unansweredGroups.has(group)) {
      groups.splice(index, 1);
    }
  }

  return TranscriptSchema.parse(
    groups.sort((left, right) => (left.seqs[0] ?? 0) - (right.seqs[0] ?? 0)),
  );
}
