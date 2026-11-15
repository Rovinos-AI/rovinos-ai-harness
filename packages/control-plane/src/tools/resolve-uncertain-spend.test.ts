// SPDX-License-Identifier: Apache-2.0
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Code, type Event } from "@rovinos/schemas";
import { InMemorySpendReservationStore } from "@rovinos/store";
import { createEventBuilders } from "@rovinos/store/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createControlPlaneServer } from "../server.js";

const connections: Array<{
  readonly client: Client;
  readonly server: ReturnType<typeof createControlPlaneServer>;
}> = [];

async function connect(store: InMemorySpendReservationStore) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createControlPlaneServer(store, {
    confirmation: { key: Buffer.alloc(32, 19) },
  });
  const client = new Client(
    { name: "spend-resolution-test", version: "1.0.0" },
    {
      capabilities: { elicitation: { form: {} } },
      versionNegotiation: { mode: "auto" },
    },
  );
  client.setRequestHandler("elicitation/create", () => ({
    action: "accept",
    content: { confirm: true },
  }));
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
});
