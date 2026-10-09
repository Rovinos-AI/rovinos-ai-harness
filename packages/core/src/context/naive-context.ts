// SPDX-License-Identifier: Apache-2.0
import type { Event, JsonValue } from "@harness/schemas";
import type { ContextPort } from "../ports.js";

/** Basic context builder that retains model outputs and tool results in order. */
export class NaiveContext implements ContextPort {
  /** {@inheritDoc ContextPort.build} */
  build(events: readonly Event[]): Promise<JsonValue> {
    return Promise.resolve(
      events.flatMap((event) => {
        if (event.type === "model_response") {
          return [event.content];
        }
        if (event.type === "tool_intent") {
          return [
            {
              type: "tool_call",
              callId: event.callId,
              toolId: event.toolId,
              args: event.args,
            },
          ];
        }
        if (event.type === "tool_result") {
          return [
            {
              callId: event.callId,
              toolId: event.toolId,
              outcome: event.outcome,
              ...(event.errorCode === undefined ? {} : { errorCode: event.errorCode }),
              result: event.result,
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
}
