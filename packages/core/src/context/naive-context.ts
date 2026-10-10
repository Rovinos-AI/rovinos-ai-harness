// SPDX-License-Identifier: Apache-2.0
import type { Event, JsonValue, Message } from "@harness/schemas";
import type { ContextPort } from "../ports.js";

/** Basic context builder that retains model outputs and tool results in order. */
export class NaiveContext implements ContextPort {
  /** {@inheritDoc ContextPort.build} */
  build(events: readonly Event[]): Promise<Message[]> {
    return Promise.resolve(
      events.flatMap<Message>((event): Message[] => {
        if (event.type === "model_response") {
          return [{ role: "assistant", parts: event.content }];
        }
        if (event.type === "tool_result") {
          return [
            {
              role: "tool",
              parts: [
                {
                  type: "tool_result",
                  isError: event.outcome !== "ok",
                  callId: event.callId,
                  result: event.result,
                },
              ],
            },
          ];
        }
        return [];
      }),
    );
  }

  /** {@inheritDoc ContextPort.snapshot} */
  snapshot(): Promise<JsonValue> {
    return Promise.resolve([]);
  }

  /** {@inheritDoc ContextPort.restore} */
  restore(_snapshot: JsonValue | undefined, _eventsAfterSnapshot: readonly Event[]): Promise<void> {
    return Promise.resolve();
  }
}
