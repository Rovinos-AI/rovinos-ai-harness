// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { attr } from "./attr.js";
import { listLogDefinitions } from "./log-registry.js";
import { __registerUnsafeSpanForTests, defineSpan, listSpanDefinitions } from "./registry.js";
import "./safe-event-logs.js";
import {
  assertRandomStringsDroppedFromLog,
  assertRandomStringsDroppedFromSpan,
  assertRegisteredSchemasSafe,
  assertSchemaCatalogSafe,
} from "./testing/registry-lint.js";

const propertySpan = defineSpan(
  "harness.test.random_string_property",
  {
    "harness.test.id": attr.id(),
    "harness.test.code": attr.code(),
    "harness.test.enum": attr.enum(["allowed", "bounded"]),
    "harness.test.count": attr.int(),
    "harness.test.enabled": attr.bool(),
    "harness.test.ratio": attr.num(),
  },
  { taskId: "4.7", packageName: "@harness/telemetry" },
);

describe("telemetry schema lint", () => {
  it("requires attr helpers for all registry and SafeEvent schema fields", () => {
    expect(listSpanDefinitions()).toContain(propertySpan);
    expect(listLogDefinitions().length).toBeGreaterThan(0);
    assertRegisteredSchemasSafe();
  });

  for (const definition of listSpanDefinitions()) {
    it(`drops unsafe random strings from span ${definition.name}`, () => {
      expect(() => {
        assertRandomStringsDroppedFromSpan(definition);
      }).not.toThrow();
    });
  }

  for (const definition of listLogDefinitions()) {
    it(`drops unsafe random strings from log ${definition.name}`, async () => {
      await expect(assertRandomStringsDroppedFromLog(definition)).resolves.toBeUndefined();
    });
  }

  it("fails schema lint when an unsafe span is registered through the test hook", () => {
    const unregister = __registerUnsafeSpanForTests("harness.test.unsafe_definition", {
      "harness.test.free_text": z.string(),
    });
    try {
      expect(assertRegisteredSchemasSafe).toThrow(
        "span harness.test.unsafe_definition field harness.test.free_text",
      );
    } finally {
      unregister();
    }
  });

  it("fails schema lint for an unsafe log definition", () => {
    expect(() => {
      assertSchemaCatalogSafe(
        [],
        [
          {
            name: "harness.test.unsafe_log",
            shape: { "harness.test.note": z.string() },
          },
        ],
        [],
      );
    }).toThrow("log harness.test.unsafe_log field harness.test.note");
  });

  it("fails schema lint for an unsafe SafeEvent field", () => {
    const unsafeEvent = z
      .object({
        kind: attr.enum(["unsafe"]),
        note: z.string(),
      })
      .strict();
    expect(() => {
      assertSchemaCatalogSafe([], [], [unsafeEvent]);
    }).toThrow("SafeEvent unsafe field note");
  });
});
