// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { PostgresEventStore } from "./adapter.js";
import { openPostgresEventStore } from "./open.js";

const connectionString = "postgresql://harness@localhost/harness";

describe("openPostgresEventStore", () => {
  it("opens a store from the minimal worker arguments", async () => {
    const store = openPostgresEventStore({ connectionString });
    expect(store).toBeInstanceOf(PostgresEventStore);
    await store.close();
  });

  it("passes optional pool, snapshot and schema settings through", async () => {
    const store = openPostgresEventStore({
      connectionString,
      poolSize: 2,
      snapshotKeep: 3,
      schema: "harness_worker",
    });
    expect(store).toBeInstanceOf(PostgresEventStore);
    await store.close();
  });

  it("rejects an invalid connection string like the adapter", () => {
    expect(() => openPostgresEventStore({ connectionString: "invalid" })).toThrow();
  });
});
