// SPDX-License-Identifier: Apache-2.0
import type { ModelPort } from "@harness/core";
import { AdapterRegistry, ModelGateway } from "@harness/models";
import { describe, expect, it } from "vitest";

describe("ModelGateway port compatibility", () => {
  it("is assignable to the core ModelPort", () => {
    const model: ModelPort = new ModelGateway(new AdapterRegistry([]), {
      ids: { next: () => "00000000000000000000000000" },
      clock: { now: () => 0 },
    });

    expect(model).toBeInstanceOf(ModelGateway);
  });
});
