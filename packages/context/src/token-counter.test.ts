// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import type { Message, ModelRef } from "@harness/schemas";
import {
  CalibratingTokenCounter,
  HeuristicTokenCounter,
} from "./token-counter.js";
import type { TokenCounter } from "./types.js";

const model: ModelRef = { provider: "openai", model: "gpt-4o" };

describe("HeuristicTokenCounter", () => {
  it("estimates Latin, CJK, and emoji samples with script-aware weighting", () => {
    const counter = new HeuristicTokenCounter();
    const messages = (text: string): Message[] => [
      { role: "user", parts: [{ type: "text", text }] },
    ];

    expect(counter.count(messages("hello"), model)).toBe(7);
    expect(counter.count(messages("こんにちは"), model)).toBe(11);
    expect(counter.count(messages("😀"), model)).toBe(6);
    expect(counter.count(messages("こんにちは"), model)).toBeGreaterThanOrEqual(
      Array.from("こんにちは").length,
    );
  });

  it("counts serialized tool and opaque payloads and tool-call overhead", () => {
    const counter = new HeuristicTokenCounter();
    const messages: Message[] = [
      {
        role: "assistant",
        parts: [
          {
            type: "tool_call",
            callId: "00000000000000000000000000",
            toolId: "search",
            args: { q: "x" },
          },
          {
            type: "tool_result",
            callId: "00000000000000000000000000",
            result: { ok: true },
            isError: false,
          },
          { type: "opaque", provider: "openai", blob: { token: "opaque" } },
        ],
      },
    ];

    expect(counter.count(messages, model)).toBeGreaterThan(30);
  });

  it("is monotonic with content length and never falls below the chars/4 baseline", () => {
    const messages = (text: string): Message[] => [
      { role: "user", parts: [{ type: "text", text }] },
    ];
    const counter = new HeuristicTokenCounter(0.1);
    const short = messages("x".repeat(80));
    const long = messages("x".repeat(160));

    expect(counter.count(long, model)).toBeGreaterThan(counter.count(short, model));
    expect(counter.count(long, model)).toBeGreaterThanOrEqual(Math.ceil(160 / 4));
  });

  it("rejects a non-positive safety factor", () => {
    expect(() => new HeuristicTokenCounter(0)).toThrow();
  });
});

describe("CalibratingTokenCounter", () => {
  const inner: TokenCounter = { count: () => 100 };
  const messages: Message[] = [{ role: "user", parts: [{ type: "text", text: "prompt" }] }];

  it("converges toward a synthetic true ratio and improves the estimate", () => {
    const counter = new CalibratingTokenCounter(inner);
    const initialError = Math.abs(counter.count(messages, model) - 150);

    for (let index = 0; index < 20; index += 1) {
      counter.observe(model, counter.count(messages, model), 150);
    }

    expect(Math.abs(counter.count(messages, model) - 150)).toBeLessThan(initialError);
    expect(counter.count(messages, model)).toBe(150);
  });

  it("clamps calibration between one half and twice the inner estimate", () => {
    const counter = new CalibratingTokenCounter(inner);

    for (let index = 0; index < 50; index += 1) {
      counter.observe(model, 100, 1_000);
    }
    expect(counter.count(messages, model)).toBe(200);

    counter.restore([{ model, ratio: 0.5 }]);
    expect(counter.count(messages, model)).toBe(50);
  });

  it("isolates models and round-trips calibration through a snapshot", () => {
    const counter = new CalibratingTokenCounter(inner);
    const otherModel = { provider: "anthropic", model: "claude" };

    counter.observe(model, 100, 150);
    counter.observe(otherModel, 100, 50);
    const snapshot = counter.snapshot();
    const restored = new CalibratingTokenCounter(inner);
    restored.restore(snapshot);

    expect(snapshot).toHaveLength(2);
    expect(restored.snapshot()).toEqual(snapshot);
    expect(restored.count(messages, model)).toBe(115);
    expect(restored.count(messages, otherModel)).toBe(85);
  });

  it("ignores observations without positive finite estimates and actual counts", () => {
    const counter = new CalibratingTokenCounter(inner);

    counter.observe(model, 0, 100);
    counter.observe(model, Number.NaN, 100);
    counter.observe(model, 100, Number.NaN);
    counter.observe(model, 100, 0);

    expect(counter.count(messages, model)).toBe(100);
  });

  it("does not let a zero usage observation change existing calibration", () => {
    const counter = new CalibratingTokenCounter(inner);
    counter.observe(model, 100, 150);
    const snapshot = counter.snapshot();

    counter.observe(model, counter.count(messages, model), 0);

    expect(counter.snapshot()).toEqual(snapshot);
  });
});

describe("TokenCounter interface", () => {
  it("allows an exact counter to be substituted", () => {
    const exactCounter: TokenCounter = { count: () => 42 };

    expect(exactCounter.count([], model)).toBe(42);
  });
});
