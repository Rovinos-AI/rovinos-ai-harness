// SPDX-License-Identifier: Apache-2.0
import {
  Code,
  Id,
  PiiPolicySchema,
  type Detection,
  type InputRequest,
  type InputResponse,
} from "@harness/schemas";
import { InMemoryEventStore } from "@harness/store";
import { InMemoryVault } from "@harness/vault";
import { Tokenizer } from "@harness/pii";
import { describe, expect, it, vi } from "vitest";
import { INPUT_WAIT_SPAN } from "../spans.js";
import {
  HumanInputBroker,
  InputChannelUnavailableError,
  InputPresentationFailedError,
} from "./broker.js";
import type { HumanInputChannel } from "./channels.js";

const runId = Id.parse("A".repeat(26));
const callId = Id.parse("B".repeat(26));
const requestId = Id.parse("C".repeat(26));
const traceId = "a".repeat(32);
const spanId = "b".repeat(16);
const email = "display-canary@example.test";
const schema = {
  type: "object" as const,
  properties: {
    email: { type: "string" as const, format: "email" as const, default: "<EMAIL_2>" },
  },
  required: ["email"],
};

function tokenizer(): Tokenizer {
  const detect = (text: string): readonly Detection[] => {
    const start = text.indexOf(email);
    return start < 0
      ? []
      : [
          {
            entityType: "email",
            start,
            end: start + email.length,
            confidence: 1,
            detectorId: "test.email",
          },
        ];
  };
  return new Tokenizer({
    detectors: { detect },
    policy: PiiPolicySchema.parse({}),
    vault: new InMemoryVault(),
  });
}

async function pendingStore(): Promise<InMemoryEventStore> {
  const store = new InMemoryEventStore();
  await store.append(
    runId,
    [
      {
        type: "run_created",
        v: 1,
        runId,
        ts: 100,
        traceId,
        spanId,
        segmentId: runId,
        configHash: "a".repeat(64),
        policyVersion: "test.policy",
        depth: 0,
      },
      {
        type: "run_status_changed",
        v: 1,
        runId,
        ts: 101,
        traceId,
        spanId,
        segmentId: runId,
        from: "pending",
        to: "running",
        reason: "started",
      },
      {
        type: "tool_intent",
        v: 1,
        runId,
        ts: 102,
        traceId,
        spanId,
        segmentId: runId,
        callId,
        toolId: "mcp.echo",
        idempotent: true,
        policyDecision: "allow",
        argsHash: "a".repeat(64),
        args: {},
      },
      {
        type: "input_requested",
        v: 1,
        runId,
        ts: 103,
        traceId,
        spanId,
        segmentId: runId,
        requestId,
        source: "mcp_mrtr",
        serverId: "mcp.server",
        callId,
        inputKey: "contact",
        round: 1,
        mode: "form",
        message: "Contact <EMAIL_1>",
        schema,
      },
      {
        type: "run_status_changed",
        v: 1,
        runId,
        ts: 104,
        traceId,
        spanId,
        segmentId: runId,
        from: "running",
        to: "suspended",
        reason: "awaiting_input",
      },
    ],
    0,
  );
  return store;
}

function channel(
  id: string,
  present: (
    req: InputRequest,
    signal: AbortSignal,
  ) => Promise<InputResponse & { principal: string }>,
): HumanInputChannel {
  return {
    id: Code.parse(id),
    available: () => true,
    present: async (req, signal) => present(req, signal),
  };
}

describe("HumanInputBroker", () => {
  it("lists tokenized requests even when no channel is available", async () => {
    const broker = new HumanInputBroker({
      store: await pendingStore(),
      channels: [],
      tokenizer: tokenizer(),
    });

    await expect(broker.listPending(runId)).resolves.toMatchObject([
      { requestId, message: "Contact <EMAIL_1>", schema },
    ]);
    await expect(
      broker.present(runId, requestId, new AbortController().signal),
    ).rejects.toBeInstanceOf(InputChannelUnavailableError);
  });

  it("re-asks once after invalid schema answers", async () => {
    const store = await pendingStore();
    const present = vi
      .fn<HumanInputChannel["present"]>()
      .mockResolvedValueOnce({ action: "accept", answer: {}, principal: Code.parse("cli.human") })
      .mockResolvedValueOnce({
        action: "accept",
        answer: { email },
        principal: Code.parse("cli.human"),
      });
    const broker = new HumanInputBroker({
      store,
      channels: [channel("channel.cli", present)],
      tokenizer: tokenizer(),
      clock: { now: () => 500 },
    });

    const resolution = await broker.present(runId, requestId, new AbortController().signal);

    expect(present).toHaveBeenCalledTimes(2);
    expect(resolution).toMatchObject({ action: "accept", answer: { email: "<EMAIL_1>" } });
  });

  it("fails after the second invalid response", async () => {
    const present = vi
      .fn<HumanInputChannel["present"]>()
      .mockResolvedValue({ action: "accept", answer: {}, principal: Code.parse("cli.human") });
    const broker = new HumanInputBroker({
      store: await pendingStore(),
      channels: [channel("channel.cli", present)],
      tokenizer: tokenizer(),
    });

    await expect(
      broker.present(runId, requestId, new AbortController().signal),
    ).rejects.toBeInstanceOf(InputPresentationFailedError);
    expect(present).toHaveBeenCalledTimes(2);
  });

  it("accepts the first valid channel answer and cancels the other channels", async () => {
    const cancelled = vi.fn();
    const winner = channel("channel.winner", (req) => {
      expect(req.message).toBe("Contact <EMAIL_1>");
      return Promise.resolve({
        action: "accept",
        answer: { email },
        principal: Code.parse("cli.winner"),
      });
    });
    const waiting = channel(
      "channel.waiting",
      (_req, signal) =>
        new Promise((resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              cancelled();
              reject(new Error("cancelled"));
            },
            { once: true },
          );
        }),
    );
    const broker = new HumanInputBroker({
      store: await pendingStore(),
      channels: [winner, waiting],
      tokenizer: tokenizer(),
    });

    const resolution = await broker.present(runId, requestId, new AbortController().signal);

    expect(resolution.approverId).toBe("cli.winner");
    expect(cancelled).toHaveBeenCalledOnce();
  });
});

describe("harness.input_wait", () => {
  it("registers only bounded request metadata and wait duration", () => {
    expect(INPUT_WAIT_SPAN.name).toBe("harness.input_wait");
    expect(Object.keys(INPUT_WAIT_SPAN.shape)).toEqual(
      expect.arrayContaining([
        "harness.input.source",
        "harness.input.mode",
        "harness.input.round",
        "harness.input.action",
        "harness.wait_ms",
      ]),
    );
    expect(Object.keys(INPUT_WAIT_SPAN.shape)).not.toContain("harness.input.answer");
  });
});
