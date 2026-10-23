// SPDX-License-Identifier: Apache-2.0
import { Id, type Event, type InputRequest } from "@harness/schemas";
import { InMemoryEventStore } from "@harness/store";
import { AuditingVaultResolver } from "@harness/vault";
import { describe, expect, it } from "vitest";
import { foldRunState, type InputRequestedEvent, type RunState } from "../run-state.js";
import { InputDestinationUnavailableError, InputSchemaUnavailableError } from "./resolve-errors.js";
import { inputDestination, inputRequestForValidation } from "./resolve-validation.js";

const runId = Id.parse("A".repeat(26));
const callId = Id.parse("B".repeat(26));
const requestId = Id.parse("C".repeat(26));

const tokenizedRequest: InputRequest = {
  requestId,
  source: "mcp_mrtr",
  callId,
  round: 1,
  mode: "form",
  message: "Pick a contact",
  schema: {
    type: "object",
    properties: { email: { type: "string", enum: ["<EMAIL_1>"] } },
  },
};

function resolverReturning(value: string | undefined): AuditingVaultResolver {
  return new AuditingVaultResolver({ resolve: () => Promise.resolve(value) }, () => undefined);
}

const envelope = {
  v: 1 as const,
  runId,
  traceId: "a".repeat(32),
  spanId: "b".repeat(16),
  segmentId: runId,
};

// A recorded log (run created, then one input request) folded into state, so the event and the
// state come from the real store and reducer rather than hand-built objects.
async function recordedInput(
  source: "mcp_legacy" | "agent",
): Promise<{ readonly event: InputRequestedEvent; readonly state: RunState }> {
  const store = new InMemoryEventStore();
  await store.append(
    runId,
    [
      {
        ...envelope,
        type: "run_created",
        ts: 100,
        configHash: "a".repeat(64),
        policyVersion: "test.policy",
        depth: 0,
      },
      {
        ...envelope,
        type: "run_status_changed",
        ts: 100,
        from: "pending",
        to: "running",
        reason: "started",
      },
      {
        ...envelope,
        type: "input_requested",
        ts: 101,
        requestId,
        source,
        ...(source === "agent" ? {} : { serverId: "mcp.server" }),
        round: 1,
        mode: "form",
        message: "Pick a contact",
        schema: { type: "object", properties: { email: { type: "string" } } },
      },
    ],
    0,
  );
  const events: Event[] = [];
  for await (const event of store.read(runId)) {
    events.push(event);
  }
  const event = events.find(
    (candidate): candidate is InputRequestedEvent => candidate.type === "input_requested",
  );
  if (event === undefined) {
    throw new Error("input_requested_missing");
  }
  return { event, state: foldRunState(events) };
}

describe("inputRequestForValidation", () => {
  it("returns a request without a schema or tokens unchanged", async () => {
    const withoutSchema: InputRequest = {
      requestId,
      source: "agent",
      round: 1,
      mode: "form",
      message: "Pick a contact",
    };
    const plain: InputRequest = {
      ...tokenizedRequest,
      schema: { type: "object", properties: { email: { type: "string" } } },
    };

    await expect(
      inputRequestForValidation(runId, withoutSchema, undefined, undefined),
    ).resolves.toBe(withoutSchema);
    await expect(inputRequestForValidation(runId, plain, undefined, undefined)).resolves.toBe(
      plain,
    );
  });

  it("fails closed when a tokenized schema has no resolver", async () => {
    await expect(
      inputRequestForValidation(runId, tokenizedRequest, undefined, undefined),
    ).rejects.toBeInstanceOf(InputSchemaUnavailableError);
  });

  it("fails closed when a schema token cannot be resolved", async () => {
    await expect(
      inputRequestForValidation(runId, tokenizedRequest, undefined, resolverReturning(undefined)),
    ).rejects.toBeInstanceOf(InputSchemaUnavailableError);
  });
});

describe("inputDestination", () => {
  it("allows the any destination only for agent questions", async () => {
    const { event, state } = await recordedInput("agent");

    expect(inputDestination(event, state)).toBe("any");
  });

  it("rejects a legacy server input that has no call id", async () => {
    const { event, state } = await recordedInput("mcp_legacy");

    expect(() => inputDestination(event, state)).toThrow(InputDestinationUnavailableError);
  });
});
