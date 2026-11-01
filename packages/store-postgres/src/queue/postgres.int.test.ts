// SPDX-License-Identifier: Apache-2.0
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { Id, SequentialIdGenerator } from "@rovinos/schemas";
import type { Clock } from "@rovinos/store";
import { createEventBuilders } from "@rovinos/store/testing";
import { PostgresEventStore } from "../postgres/adapter.js";
import { PostgresRunQueue } from "./postgres.js";
import { runQueueConformance, type RunQueueFactoryCreator } from "@rovinos/store/testing";

const connectionString =
  process.env.TEST_POSTGRES_URL ?? "postgresql://harness@127.0.0.1:5432/harness";
const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function uniqueSchema(): string {
  let value = BigInt(`0x${randomBytes(16).toString("hex")}`);
  let suffix = "";
  for (let index = 0; index < 26; index += 1) {
    suffix = `${alphabet[Number(value & 31n)] ?? "0"}${suffix}`;
    value >>= 5n;
  }
  return `q_${suffix}`;
}

const postgresFactory: RunQueueFactoryCreator = async (clock: Clock) => {
  const admin = new Pool({ connectionString, max: 1 });
  const schema = uniqueSchema();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const ids = new SequentialIdGenerator();
  const queues = new Set<PostgresRunQueue>();
  const store = new PostgresEventStore(connectionString, { schema }, undefined, clock);
  const builders = createEventBuilders();
  return {
    open() {
      const queue = new PostgresRunQueue(connectionString, { poolSize: 3, schema }, clock, ids);
      queues.add(queue);
      return queue;
    },
    async seedRun(runId, identity) {
      const id = Id.parse(runId);
      await store.append(
        id,
        [
          {
            ...builders.runCreated(id),
            ...(identity.requestedBy === undefined ? {} : { requestedBy: identity.requestedBy }),
            ...(identity.role === undefined ? {} : { quotaRole: identity.role }),
          },
        ],
        0,
      );
    },
    async cleanup() {
      await Promise.all([...queues].map((queue) => queue.close()));
      await store.close();
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    },
  };
};

runQueueConformance("PostgresRunQueue", postgresFactory);
