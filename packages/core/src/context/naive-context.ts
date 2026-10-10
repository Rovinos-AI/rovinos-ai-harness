// SPDX-License-Identifier: Apache-2.0
import { NaiveStrategy } from "@harness/context";
import type { TokenCounter } from "@harness/context";
import type { ModelRef } from "@harness/schemas";
import { StrategyContextPort } from "./context-port.js";

const defaultModel: ModelRef = { provider: "default", model: "default" };
const defaultCounter: TokenCounter = { count: () => 0 };

/** Basic strategy-backed context port retained for existing core integrations. */
export class NaiveContext extends StrategyContextPort {
  constructor() {
    super(new NaiveStrategy(), {
      budget: { maxTokens: Number.MAX_SAFE_INTEGER, reserveOutputTokens: 0 },
      model: defaultModel,
      counter: defaultCounter,
    });
  }
}
