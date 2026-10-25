// SPDX-License-Identifier: Apache-2.0
import { PiiConfigSchema } from "@rovinos/schemas";
import { InMemoryEventStore } from "@rovinos/store";
import { runEventStoreConformance, type EventStoreFactory } from "@rovinos/store/testing";
import { InMemoryVault } from "@rovinos/vault";
import { PiiEventStore, Tokenizer } from "@rovinos/pii";

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
