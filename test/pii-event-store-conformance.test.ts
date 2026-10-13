// SPDX-License-Identifier: Apache-2.0
import { PiiConfigSchema } from "@harness/schemas";
import { InMemoryEventStore } from "@harness/store";
import { runEventStoreConformance, type EventStoreFactory } from "@harness/store/testing";
import { InMemoryVault } from "@harness/vault";
import { PiiEventStore, Tokenizer } from "@harness/pii";

const conformanceFactory: EventStoreFactory = () => {
  const inner = new InMemoryEventStore();
  const store = new PiiEventStore(
    inner,
    new Tokenizer({
      detectors: { detect: () => [] },
      policy: PiiConfigSchema.parse({}),
      vault: new InMemoryVault(),
    }),
  );
  return Promise.resolve({ store, cleanup: () => store.close() });
};

runEventStoreConformance("PiiEventStore", conformanceFactory, {
  supportsFileReopen: false,
});
