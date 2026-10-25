// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { parseJson } from "@rovinos/schemas";
import * as store from "@rovinos/store";
import { runEventStoreConformance } from "@rovinos/store/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const manifestSchema = z.looseObject({
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
});

describe("@rovinos/store entry point", () => {
  it("does not export test-only conformance helpers", () => {
    expect("runEventStoreConformance" in store).toBe(false);
  });

  it("exposes conformance helpers from the testing subpath", () => {
    expect(runEventStoreConformance).toBeTypeOf("function");
  });

  it("does not depend on either database driver", () => {
    const manifest = parseJson(
      manifestSchema,
      readFileSync(new URL("../packages/store/package.json", import.meta.url), "utf8"),
    );
    for (const dependencies of [manifest.dependencies, manifest.devDependencies]) {
      expect(dependencies).not.toHaveProperty("better-sqlite3");
      expect(dependencies).not.toHaveProperty("pg");
      expect(dependencies).not.toHaveProperty("@types/better-sqlite3");
      expect(dependencies).not.toHaveProperty("@types/pg");
    }
  });
});
