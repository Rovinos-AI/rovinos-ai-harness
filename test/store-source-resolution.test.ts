// SPDX-License-Identifier: Apache-2.0
import { Id } from "@rovinos/schemas";
import { InMemoryEventStore } from "@rovinos/store";
import { expect, it } from "vitest";

it("resolves the store source export without a built package", async () => {
  const store = new InMemoryEventStore();

  await expect(store.head(Id.parse("00000000000000000000000001"))).resolves.toBe(0);
});
