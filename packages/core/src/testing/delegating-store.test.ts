// SPDX-License-Identifier: Apache-2.0
import { InMemoryEventStore } from "@rovinos/store";
import { runEventStoreConformance, type EventStoreFactory } from "@rovinos/store/testing";
import { delegatingStore } from "./delegating-store.js";

const factory: EventStoreFactory = () => {
  const inner = new InMemoryEventStore();
  return Promise.resolve({
    store: delegatingStore(inner),
    cleanup: () => inner.close(),
  });
};

runEventStoreConformance("delegating event store", factory, { supportsFileReopen: false });
