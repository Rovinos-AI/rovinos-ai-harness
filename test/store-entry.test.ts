// SPDX-License-Identifier: Apache-2.0
import * as store from "@harness/store";
import { runEventStoreConformance } from "@harness/store/testing";
import { describe, expect, it } from "vitest";

describe("@harness/store entry point", () => {
  it("does not export test-only conformance helpers", () => {
    expect("runEventStoreConformance" in store).toBe(false);
  });

  it("exposes conformance helpers from the testing subpath", () => {
    expect(runEventStoreConformance).toBeTypeOf("function");
  });
});
