// SPDX-License-Identifier: Apache-2.0
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { inputRequired } from "@modelcontextprotocol/server";
import { Code, type Event } from "@rovinos/schemas";
import { InMemoryEventStore, InMemorySpendReservationStore, type EventStore } from "@rovinos/store";
import { createEventBuilders } from "@rovinos/store/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmationGate } from "../confirmation-gate.js";
import { createControlPlaneServer } from "../server.js";

const connections: {
  readonly client: Client;
  readonly server: ReturnType<typeof createControlPlaneServer>;
}[] = [];

async function connect(
  store: EventStore,
  options: Parameters<typeof createControlPlaneServer>[1] = {},
  response: "accept" | "decline" | null = "accept",
) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createControlPlaneServer(store, {
    confirmation: { key: Buffer.alloc(32, 19) },
    ...options,
  });
  const client = new Client(
    { name: "spend-resolution-test", version: "1.0.0" },
    {
      capabilities: response === null ? {} : { elicitation: { form: {} } },
      versionNegotiation: { mode: "auto" },
    },
  );
  if (response !== null) {
    client.setRequestHandler("elicitation/create", () => ({
      action: response,
      ...(response === "accept" ? { content: { confirm: true } } : {}),
    }));
  }
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const connection = { client, server };
  connections.push(connection);
  return connection;
}

afterEach(async () => {
  await Promise.all(
    connections.splice(0).map(async ({ client, server }) => {
      await client.close();
      await server.close();
    }),
  );
});

describe("resolve_uncertain_spend", () => {
  it("requires human confirmation and records the operator decision in the run log", async () => {
    const store = new InMemorySpendReservationStore();
    const builders = createEventBuilders();
    const runId = builders.nextRunId();
    const attemptId = builders.nextRunId();
    await store.append(runId, [builders.runCreated(runId)], 0);
    await store.reserveSpend(
      {
        runId,
        attemptId,
        quotaPeriods: [
          {
            quotaId: Code.parse("quota.test"),
            period: "day",
            periodStart: Date.UTC(2024, 0, 1),
            limitMicros: 10_000,
          },
        ],
        estimatedMicros: 100,
        pricingRevision: Code.parse("price.test"),
      },
      { ...builders.modelRequest(runId), requestId: attemptId },
      1,
    );
    await store.markSpendDispatching(attemptId);
    await store.markSpendUncertain(attemptId, "spend_reservation_worker_lease_expired");
    const { client } = await connect(store);

    await expect(
      client.callTool({
        name: "resolve_uncertain_spend",
        arguments: { runId, attemptId, reason: "operator_reviewed" },
      }),
    ).resolves.toMatchObject({ structuredContent: { ok: true } });
    const events: Event[] = [];
    for await (const event of store.read(runId)) {
      events.push(event);
    }
    expect(events.at(-1)).toMatchObject({
      type: "spend_reservation_resolved",
      attemptId,
      decision: "waive",
      decidedBy: "cli.control_plane",
      reason: "operator_reviewed",
    });
  });

  it("returns input-required and denied confirmation results without changing the store", async () => {
    const store = new InMemorySpendReservationStore();
    const gate = new ConfirmationGate({ key: Buffer.alloc(32, 19) });
    vi.spyOn(gate, "requireHuman").mockResolvedValue({
      status: "input_required",
      result: inputRequired({ requestState: "synthetic-state" }),
    });
    const builders = createEventBuilders();
    const runId = builders.nextRunId();
    const attemptId = builders.nextRunId();
    await store.append(runId, [builders.runCreated(runId)], 0);
    const { client } = await connect(store, { confirmationGate: gate }, null);
    await expect(
      client.callTool({
        name: "resolve_uncertain_spend",
        arguments: { runId, attemptId, reason: "operator_reviewed" },
      }),
    ).rejects.toThrow();

    const deniedGate = new ConfirmationGate({ key: Buffer.alloc(32, 19) });
    vi.spyOn(deniedGate, "requireHuman").mockResolvedValue({
      status: "denied",
      code: Code.parse("human_confirmation_declined"),
    });
    const { client: deniedClient } = await connect(store, { confirmationGate: deniedGate });
    await expect(
      deniedClient.callTool({
        name: "resolve_uncertain_spend",
        arguments: { runId, attemptId, reason: "operator_reviewed" },
      }),
    ).resolves.toMatchObject({
      isError: true,
      structuredContent: { ok: false, code: "human_confirmation_declined" },
    });
  });

  it("rejects a regular event store and reports a missing run", async () => {
    const builders = createEventBuilders();
    const runId = builders.nextRunId();
    const attemptId = builders.nextRunId();
    const { client } = await connect(new InMemoryEventStore());
    await expect(
      client.callTool({
        name: "resolve_uncertain_spend",
        arguments: { runId, attemptId, reason: "operator_reviewed" },
      }),
    ).resolves.toMatchObject({
      isError: true,
      structuredContent: { ok: false, code: "spend_reservation_storage_unavailable" },
    });

    const reservationStore = new InMemorySpendReservationStore();
    const missingRunClient = await connect(reservationStore);
    await expect(
      missingRunClient.client.callTool({
        name: "resolve_uncertain_spend",
        arguments: { runId, attemptId, reason: "operator_reviewed" },
      }),
    ).resolves.toMatchObject({
      isError: true,
      structuredContent: { ok: false, code: "run_not_found" },
    });
  });

  it("maps coded and unknown reservation resolution failures safely", async () => {
    const builders = createEventBuilders();
    const runId = builders.nextRunId();
    const attemptId = builders.nextRunId();
    for (const [failure, expectedCode] of [
      [
        Object.assign(new Error("synthetic conflict"), {
          code: Code.parse("spend_reservation_conflict"),
        }),
        "spend_reservation_conflict",
      ],
      [new Error("synthetic failure"), "spend_reservation_resolution_failed"],
    ] as const) {
      const base = new InMemorySpendReservationStore();
      await base.append(runId, [builders.runCreated(runId)], 0);
      vi.spyOn(base, "resolveUncertainSpend").mockRejectedValue(failure);
      const { client } = await connect(base);
      await expect(
        client.callTool({
          name: "resolve_uncertain_spend",
          arguments: { runId, attemptId, reason: "operator_reviewed" },
        }),
      ).resolves.toMatchObject({
        isError: true,
        structuredContent: { ok: false, code: expectedCode },
      });
    }
  });
});
