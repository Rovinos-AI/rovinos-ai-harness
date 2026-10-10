// SPDX-License-Identifier: Apache-2.0
import type { Code, Message } from "@harness/schemas";

/**
 * Prepare normalized conversation messages for a provider without discarding its reusable blobs.
 *
 * @param messages - Validated conversation history.
 * @param provider - Provider receiving the history.
 * @returns Detached messages with only provider-matching opaque parts.
 */
export function prepareMessagesForProvider(
  messages: readonly Message[],
  provider: Code,
): Message[] {
  return messages.map((message) => {
    const hasMatchingBlob = message.parts.some(
      (part) => part.type === "opaque" && part.provider === provider,
    );
    const parts = message.parts.filter((part) => {
      if (part.type === "opaque") {
        return part.provider === provider;
      }
      return (
        message.role !== "assistant" ||
        hasMatchingBlob ||
        part.type === "text" ||
        part.type === "tool_call"
      );
    });
    return { role: message.role, parts };
  });
}
