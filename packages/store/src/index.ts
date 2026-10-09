// SPDX-License-Identifier: Apache-2.0
export { InvalidEventError, SeqConflictError, StoreUnavailableError } from "./errors.js";
export { JsonContentCodec } from "./codec.js";
export { InMemoryEventStore } from "./memory.js";
export { SqliteEventStore } from "./sqlite/adapter.js";
export { runEventStoreConformance } from "./conformance.js";
export type { ContentCodec, ContentCodecContext, EncodedContent } from "./codec.js";
export type { EventStoreConformanceCaps, EventStoreFactory } from "./conformance.js";
export type { EventStore, ListRunsOptions, RunSummary } from "./types.js";
