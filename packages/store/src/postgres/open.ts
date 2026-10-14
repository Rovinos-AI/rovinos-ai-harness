// SPDX-License-Identifier: Apache-2.0
import { PostgresEventStore, type PostgresEventStoreOptions } from "./adapter.js";

/** Open a Postgres event store from the JSON arguments supplied to a worker thread. */
export function openPostgresEventStore(args: {
  readonly connectionString: string;
  readonly poolSize?: number;
  readonly snapshotKeep?: number;
  readonly schema?: string;
}): PostgresEventStore {
  const options: PostgresEventStoreOptions = {
    ...(args.poolSize === undefined ? {} : { poolSize: args.poolSize }),
    ...(args.snapshotKeep === undefined ? {} : { snapshotKeep: args.snapshotKeep }),
    ...(args.schema === undefined ? {} : { schema: args.schema }),
  };
  return new PostgresEventStore(args.connectionString, options);
}
