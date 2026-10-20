// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createEventBuilders } from "@harness/store/testing";
import { openSqliteEventStore } from "./sqlite-worker-open.js";

describe("openSqliteEventStore", () => {
  it("opens a file-backed store that appends and reads events", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-store-worker-open-"));
    const store = openSqliteEventStore({ path: join(directory, "events.sqlite") });
    const builders = createEventBuilders();

    try {
      const runId = builders.nextRunId();
      const event = builders.runCreated(runId);

      await expect(store.append(runId, [event], 0)).resolves.toEqual({ nextSeq: 1 });
      const events = [];
      for await (const storedEvent of store.read(runId)) {
        events.push(storedEvent);
      }
      expect(events).toEqual([{ ...event, seq: 0 }]);
    } finally {
      try {
        await store.close();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });
});
